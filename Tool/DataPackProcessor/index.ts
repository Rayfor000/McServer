import { execSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { cleanToUtf8LfNoTrailingNewlines, ensureSingleTrailingLFSuffix, matchSourceTrailingLF } from './formatUtil.js';
import { JsonProcessor } from './jsonProcessor.js';
import { McfunctionProcessor } from './mcfunctionProcessor.js';
import { SnbtProcessor } from './snbtProcessor.js';
import { initSpyglass, SpyglassContext } from './spyglassProject.js';
import { TranslationManager } from './translationManager.js';

// Dynamically import sharp if available for image compression
let sharp: any = null;
try {
	const sharpModule = await import('sharp');
	sharp = sharpModule.default || sharpModule;
} catch (e) {
	// sharp not available or failed to load
}

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.json', '.mcmeta', '.snbt', '.mcfunction', '.properties', '.lang', '.yml', '.yaml', '.csv']);

interface Args {
	version: string;
	spyglassDir: string;
	input: string;
	output: string;
	compressImages: boolean;
	minify: boolean;
	removeUnnecessary: boolean;
	forceOverwrite: boolean;
	autoLang: boolean;
	useHeuristic: boolean;
}

function isSinglePack(p: string): boolean {
	const isExplicitDir = p.endsWith('/') || p.endsWith('\\');

	const stat = fs.statSync(p);
	if (stat.isFile() && p.toLowerCase().endsWith('.zip') && !isExplicitDir) {
		return true;
	}
	if (stat.isDirectory()) {
		return fs.existsSync(path.join(p, 'data')) || fs.existsSync(path.join(p, 'assets')) || fs.existsSync(path.join(p, 'pack.mcmeta'));
	}
	return false;
}

function extractZip(zipPath: string, targetDir: string) {
	fs.mkdirSync(targetDir, { recursive: true });
	if (process.platform === 'win32') {
		execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${targetDir}' -Force"`, { stdio: 'ignore' });
	} else {
		execSync(`unzip -o "${zipPath}" -d "${targetDir}"`, { stdio: 'ignore' });
	}
}

async function compressImage(src: string, dest: string): Promise<boolean> {
	if (!sharp) {
		return false;
	}
	try {
		await sharp(src).png({ palette: true, quality: 80, compressionLevel: 9 }).toFile(dest);
		return true;
	} catch (e) {
		return false;
	}
}

function minifyJsonContent(content: string): string {
	try {
		const parsed = JSON.parse(content);
		return JSON.stringify(parsed).trim();
	} catch (e) {
		// If invalid JSON, just return original content directly instead of stripping whitespace in values
		return content;
	}
}

function minifyMcfunctionContent(content: string): string {
	const lines = content.split(/\r?\n/);
	const processedLines: string[] = [];
	let currentLine = '';

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) {
			continue;
		}

		if (trimmed.endsWith('\\')) {
			// Strip the backslash and any trailing whitespace, then append to current logical line with a single space to avoid clashing
			const segment = trimmed.slice(0, -1).trimEnd();
			if (currentLine) {
				currentLine += currentLine.endsWith(' ') || segment.startsWith(' ') ? segment : ' ' + segment;
			} else {
				currentLine += segment;
			}
		} else {
			if (currentLine) {
				currentLine += currentLine.endsWith(' ') || trimmed.startsWith(' ') ? trimmed : ' ' + trimmed;
			} else {
				currentLine += trimmed;
			}
			processedLines.push(currentLine);
			currentLine = '';
		}
	}

	if (currentLine) {
		processedLines.push(currentLine);
	}

	return processedLines.join('\n').trim();
}

/**
 * Recursively walks a directory and returns all file paths.
 */
function getAllFiles(dir: string): string[] {
	const results: string[] = [];
	if (!fs.existsSync(dir)) return results;
	const list = fs.readdirSync(dir);
	for (const file of list) {
		const fullPath = path.join(dir, file);
		if (fs.statSync(fullPath).isDirectory()) {
			results.push(...getAllFiles(fullPath));
		} else {
			results.push(fullPath);
		}
	}
	return results;
}

async function processSinglePack(
	packSrc: string,
	packOut: string,
	spyglass: SpyglassContext,
	version: string,
	options: {
		compressImages: boolean;
		minify: boolean;
		removeUnnecessary: boolean;
		autoLang: boolean;
		useHeuristic: boolean;
	},
) {
	const isZip = fs.statSync(packSrc).isFile() && packSrc.toLowerCase().endsWith('.zip');
	let actualSrc = packSrc;
	let tempDir: string | null = null;

	if (isZip) {
		console.log(`[Processor] Extracting ZIP pack: ${path.basename(packSrc)}`);
		const tempBase = path.join(os.tmpdir(), 'spyglass-datapack-' + crypto.randomBytes(6).toString('hex'));
		extractZip(packSrc, tempBase);
		tempDir = tempBase;
		actualSrc = tempBase;

		const subdirs = fs.readdirSync(tempBase).filter((f) => fs.statSync(path.join(tempBase, f)).isDirectory());
		if (subdirs.length === 1 && !fs.existsSync(path.join(tempBase, 'data')) && !fs.existsSync(path.join(tempBase, 'assets'))) {
			const nestedDir = path.join(tempBase, subdirs[0]);
			if (fs.existsSync(path.join(nestedDir, 'data')) || fs.existsSync(path.join(nestedDir, 'assets')) || fs.existsSync(path.join(nestedDir, 'pack.mcmeta'))) {
				actualSrc = nestedDir;
			}
		}
	}

	console.log(`[Processor] Processing pack: ${path.basename(packSrc)} -> ${packOut}`);

	const translationManager = new TranslationManager();

	// Always load existing assets/<namespace>/lang/*.json translations
	// We want to load existing translations for alignment and sync if autoLang is enabled,
	// or simply populate languages.
	const searchDirs = [packOut, actualSrc];
	const rawLangData: Record<string, Record<string, string>> = {}; // langCode -> content

	for (const baseDir of searchDirs) {
		const assetsDir = path.join(baseDir, 'assets');
		if (fs.existsSync(assetsDir)) {
			const namespaces = fs.readdirSync(assetsDir).filter((f) => fs.statSync(path.join(assetsDir, f)).isDirectory());
			for (const ns of namespaces) {
				const langDir = path.join(assetsDir, ns, 'lang');
				if (fs.existsSync(langDir)) {
					const langFiles = fs.readdirSync(langDir).filter((f) => f.endsWith('.json'));
					for (const file of langFiles) {
						const langCode = path.basename(file, '.json').toLowerCase().trim();
						const langPath = path.join(langDir, file);
						try {
							const langContent = fs.readFileSync(langPath, 'utf-8');
							const langJson = JSON.parse(langContent);
							if (langCode === 'main') {
								translationManager.loadExistingTranslations('main', langJson);
								console.log(`[Processor] Loaded existing translations for 'main' from: ${langPath}`);
							} else {
								// Save other languages raw data for auto language alignment processing
								rawLangData[langCode] = {
									...rawLangData[langCode],
									...langJson,
								};
							}
						} catch (e) {
							// Ignore parsing errors
						}
					}
				}
			}
		}
	}

	const jsonProcessor = new JsonProcessor(spyglass, translationManager);
	const snbtProcessor = new SnbtProcessor(spyglass, translationManager);
	const mcfunctionProcessor = new McfunctionProcessor(spyglass, translationManager);

	fs.mkdirSync(packOut, { recursive: true });

	const filesToProcess = getAllFiles(actualSrc);
	const sourceRelPaths = new Set<string>();

	// Determine which files are allowed to be written
	const allowedFiles = new Map<string, string>(); // relPath -> sourceFullPath

	for (const file of filesToProcess) {
		const relPath = path.relative(actualSrc, file);
		const pathParts = relPath.split(path.sep);

		if (options.removeUnnecessary) {
			const isRootFile = pathParts.length === 1;
			if (isRootFile && relPath.toLowerCase() !== 'pack.mcmeta') {
				continue;
			}
		}

		sourceRelPaths.add(relPath);
		allowedFiles.set(relPath, file);
	}

	// Clean up files in output directory that are no longer allowed or present
	// This handles the case where -c, -m, or -r options changed, or files were deleted
	if (fs.existsSync(packOut)) {
		const existingOutputFiles = getAllFiles(packOut);

		for (const outFile of existingOutputFiles) {
			const relPath = path.relative(packOut, outFile);
			const isLangFile = relPath.startsWith(`assets${path.sep}`) && relPath.endsWith('.json') && relPath.includes(`lang${path.sep}`);
			const isReportFile = relPath === 'language_report.json';

			// Do not delete lang files or language_report.json as they are generated/updated at the end
			if (isLangFile || isReportFile) {
				continue;
			}

			if (!allowedFiles.has(relPath)) {
				try {
					fs.unlinkSync(outFile);
					console.log(`  [Cleanup] Removed obsolete/unnecessary file: ${relPath}`);
				} catch (e) {
					// Ignore unlink errors
				}
			}
		}

		// Clean up empty directories in packOut
		const cleanEmptyDirs = (dir: string) => {
			if (!fs.existsSync(dir)) return;
			const list = fs.readdirSync(dir);
			for (const file of list) {
				const fullPath = path.join(dir, file);
				if (fs.statSync(fullPath).isDirectory()) {
					cleanEmptyDirs(fullPath);
				}
			}
			// Re-read list to see if it's empty now
			if (fs.readdirSync(dir).length === 0 && dir !== packOut) {
				try {
					fs.rmdirSync(dir);
				} catch (e) {}
			}
		};
		cleanEmptyDirs(packOut);
	}

	let modifiedCount = 0;
	let unchangedCount = 0;

	for (const [relPath, file] of allowedFiles.entries()) {
		const targetPath = path.join(packOut, relPath);
		const ext = path.extname(file).toLowerCase();
		const pathParts = relPath.split(path.sep);

		// Handle image compression
		if (ext === '.png') {
			fs.mkdirSync(path.dirname(targetPath), { recursive: true });
			if (options.compressImages) {
				// Check if target already exists and is identical to avoid redundant compression
				let shouldCompress = true;
				if (fs.existsSync(targetPath)) {
					const srcStat = fs.statSync(file);
					const destStat = fs.statSync(targetPath);
					// Simple heuristic: if destination exists and is smaller or equal, and source hasn't changed, skip
					if (srcStat.mtimeMs <= destStat.mtimeMs) {
						shouldCompress = false;
					}
				}
				if (shouldCompress) {
					const compressed = await compressImage(file, targetPath);
					if (compressed) {
						console.log(`  [Compressed Image] ${relPath}`);
						continue;
					}
				} else {
					continue; // Skip redundant compression
				}
			}

			// If not compressing or compression failed/skipped, copy only if different
			let shouldCopy = true;
			if (fs.existsSync(targetPath)) {
				const srcBuf = fs.readFileSync(file);
				const destBuf = fs.readFileSync(targetPath);
				if (srcBuf.equals(destBuf)) {
					shouldCopy = false;
				}
			}
			if (shouldCopy) {
				fs.copyFileSync(file, targetPath);
			}
			continue;
		}

		const content = fs.readFileSync(file, 'utf-8');
		let processedContent = content;
		let modified = false;

		let namespace = 'minecraft';
		const dataIdx = pathParts.indexOf('data');
		if (dataIdx !== -1 && dataIdx + 1 < pathParts.length) {
			namespace = pathParts[dataIdx + 1];
		}

		try {
			if (ext === '.json' || relPath.toLowerCase() === 'pack.mcmeta') {
				if (ext === '.json') {
					const schemaPath = getSchemaPathForJson(relPath);
					const isAssetFile = pathParts.includes('assets');

					// Safe control: assets (Resource Pack) JSONs should NOT be parsed/translated. Only data (Data Pack) JSONs are eligible.
					if (schemaPath && !isAssetFile) {
						const result = jsonProcessor.processJson(content, relPath, schemaPath, namespace);
						processedContent = result.content;
						modified = result.modified;
					} else if (!isAssetFile && options.useHeuristic) {
						// Apply safe heuristic fallback translation processing ONLY for data files lacking a strict schema, if enabled by user
						const result = jsonProcessor.processJsonHeuristic(content, relPath, namespace);
						processedContent = result.content;
						modified = result.modified;
					}
				}
				if (options.minify) {
					processedContent = minifyJsonContent(processedContent);
				} else {
					processedContent = processedContent.replace(/\r\n/g, '\n').replace(/\n+$/, '');
				}
				processedContent = matchSourceTrailingLF(processedContent);
			} else if (ext === '.snbt') {
				const schemaPath = '::java::server::util::text::Text';
				const result = snbtProcessor.processSnbt(content, relPath, schemaPath, namespace);
				processedContent = result.content;
				modified = result.modified;
				processedContent = processedContent.replace(/\r\n/g, '\n').replace(/\n+$/, '');
				processedContent = matchSourceTrailingLF(processedContent);
			} else if (ext === '.mcfunction') {
				const result = mcfunctionProcessor.processMcfunction(content, relPath, namespace, options.minify);
				processedContent = result.content;
				modified = result.modified;

				if (options.minify) {
					processedContent = minifyMcfunctionContent(processedContent);
				} else {
					processedContent = processedContent.replace(/\r\n/g, '\n').replace(/\n+$/, '');
				}

				processedContent = matchSourceTrailingLF(processedContent);
			} else {
				// For other files, convert to UTF-8 + LF + NO \n if they are text-like files, otherwise copy binary directly.
				if (TEXT_EXTENSIONS.has(ext)) {
					const textContent = cleanToUtf8LfNoTrailingNewlines(fs.readFileSync(file, 'utf-8'));
					let shouldWrite = true;
					if (fs.existsSync(targetPath)) {
						const existingContent = fs.readFileSync(targetPath, 'utf-8');
						if (existingContent === textContent) {
							shouldWrite = false;
						}
					}
					if (shouldWrite) {
						fs.mkdirSync(path.dirname(targetPath), { recursive: true });
						fs.writeFileSync(targetPath, textContent, 'utf-8');
					}
				} else {
					let shouldCopy = true;
					if (fs.existsSync(targetPath)) {
						const srcBuf = fs.readFileSync(file);
						const destBuf = fs.readFileSync(targetPath);
						if (srcBuf.equals(destBuf)) {
							shouldCopy = false;
						}
					}
					if (shouldCopy) {
						fs.mkdirSync(path.dirname(targetPath), { recursive: true });
						fs.copyFileSync(file, targetPath);
					}
				}
				continue;
			}

			// Ensure processedContent is fully cleaned to UTF-8, LF, and NO trailing newlines
			processedContent = cleanToUtf8LfNoTrailingNewlines(processedContent);

			// Only write if the file does not exist or content is different to reduce IO operations
			let shouldWrite = true;
			if (fs.existsSync(targetPath)) {
				const existingContent = fs.readFileSync(targetPath, 'utf-8');
				if (existingContent === processedContent) {
					shouldWrite = false;
				}
			}

			if (shouldWrite) {
				fs.mkdirSync(path.dirname(targetPath), { recursive: true });
				fs.writeFileSync(targetPath, processedContent, 'utf-8');
				if (modified) {
					modifiedCount++;
					console.log(`  [Processed] ${relPath} (Modified & Written)`);
				} else {
					unchangedCount++;
					console.log(`  [Written] ${relPath} (Unchanged but Written)`);
				}
			} else {
				if (modified) {
					modifiedCount++;
					console.log(`  [Processed] ${relPath} (Modified but Identical to Output, Skipped Write)`);
				} else {
					unchangedCount++;
				}
			}
		} catch (err: any) {
			console.error(`  [Error] Failed to process ${relPath}:`, err.message);
			fs.mkdirSync(path.dirname(targetPath), { recursive: true });
			// If text file, clean it when writing back as fallback
			if (TEXT_EXTENSIONS.has(ext)) {
				try {
					const textContent = cleanToUtf8LfNoTrailingNewlines(fs.readFileSync(file, 'utf-8'));
					fs.writeFileSync(targetPath, textContent, 'utf-8');
				} catch (e) {
					fs.copyFileSync(file, targetPath);
				}
			} else {
				fs.copyFileSync(file, targetPath);
			}
		}
	}

	console.log(`[Processor] Pack complete. Modified: ${modifiedCount}, Unchanged: ${unchangedCount}`);

	// Write main.json
	const mainJson = translationManager.getLanguageJson('main');
	const langDir = path.join(packOut, 'assets', 'minecraft', 'lang');
	const mainPath = path.join(langDir, `main.json`);
	const mainContent = ensureSingleTrailingLFSuffix(JSON.stringify(mainJson, null, 2));

	fs.mkdirSync(langDir, { recursive: true });
	fs.writeFileSync(mainPath, mainContent, 'utf-8');
	console.log(`[Processor] Generated main language file: main.json`);

	// Automatic language alignment processing
	if (options.autoLang) {
		const report: Record<string, { excess: Record<string, string>; missing: Record<string, string> }> = {};

		for (const [langCode, langData] of Object.entries(rawLangData)) {
			if (langCode === 'main') continue;

			const alignedLang: Record<string, string> = {};
			const excess: Record<string, string> = {};
			const missing: Record<string, string> = {};

			// Alignment loop: Align key to main.json
			for (const [key, mainValue] of Object.entries(mainJson)) {
				if (key in langData) {
					alignedLang[key] = langData[key];
				} else {
					alignedLang[key] = mainValue;
					missing[key] = mainValue;
				}
			}

			// Excess loop: check for keys in langData that aren't in main.json
			for (const [key, langValue] of Object.entries(langData)) {
				if (!(key in mainJson)) {
					excess[key] = langValue;
				}
			}

			// Write aligned language file (aligned key structure matching main.json)
			const alignedPath = path.join(langDir, `${langCode}.json`);
			const alignedContent = ensureSingleTrailingLFSuffix(JSON.stringify(alignedLang, null, 2));
			fs.writeFileSync(alignedPath, alignedContent, 'utf-8');
			console.log(`[Processor] Automatically aligned language file: ${langCode}.json`);

			if (Object.keys(excess).length > 0 || Object.keys(missing).length > 0) {
				report[langCode] = {
					excess,
					missing,
				};
			}
		}

		// Write language_report.json
		const reportPath = path.join(packOut, 'language_report.json');
		if (Object.keys(report).length > 0) {
			const reportContent = ensureSingleTrailingLFSuffix(JSON.stringify(report, null, 2));
			fs.writeFileSync(reportPath, reportContent, 'utf-8');
			console.log(`[Processor] Generated language_report.json at: ${reportPath}`);
		} else {
			// If no mismatches, remove previous report file to keep workspace clean
			if (fs.existsSync(reportPath)) {
				try {
					fs.unlinkSync(reportPath);
				} catch (e) {}
			}
		}
	} else {
		// If autoLang is not enabled, just write any other loaded languages as-is (e.g. if loaded but not aligning)
		for (const langCode of translationManager.getLoadedLanguages()) {
			if (langCode === 'main') continue;
			const langJson = translationManager.getLanguageJson(langCode);
			const langPath = path.join(langDir, `${langCode}.json`);
			const langContent = ensureSingleTrailingLFSuffix(JSON.stringify(langJson, null, 2));
			fs.writeFileSync(langPath, langContent, 'utf-8');
		}
	}

	if (tempDir) {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
}

async function main() {
	const argv = (await yargs(hideBin(process.argv))
		.version(false)
		.option('version', {
			alias: 'v',
			type: 'string',
			description: 'Minecraft Data Pack version (e.g., 1.21.11)',
			demandOption: true,
		})
		.option('spyglassDir', {
			alias: 's',
			type: 'string',
			description: 'Path to Spyglass-main directory',
			demandOption: true,
		})
		.option('input', {
			alias: 'i',
			type: 'string',
			description: 'Input directory or file to process',
			demandOption: true,
		})
		.option('output', {
			alias: 'o',
			type: 'string',
			description: 'Output directory for processed files',
			demandOption: true,
		})
		.option('compressImages', {
			alias: 'c',
			type: 'boolean',
			description: 'Whether to compress PNG images',
			default: false,
		})
		.option('minify', {
			alias: 'm',
			type: 'boolean',
			description: 'Whether to minify JSON, MCMETA, and MCFUNCTION files',
			default: false,
		})
		.option('removeUnnecessary', {
			alias: 'r',
			type: 'boolean',
			description: 'Whether to remove unnecessary files (keeping only directories and pack.mcmeta)',
			default: false,
		})
		.option('forceOverwrite', {
			alias: 'f',
			type: 'boolean',
			description: 'Whether to force overwrite the target directory by completely deleting it first',
			default: false,
		})
		.option('autoLang', {
			alias: 'a',
			type: 'boolean',
			description: 'Whether to automatically align and synchronize language files based on main.json',
			default: false,
		})
		.option('useHeuristic', {
			alias: 'u',
			type: 'boolean',
			description: 'Whether to enable safe heuristic fallback translation parsing for files lacking strict mcdoc schemas',
			default: false,
		})
		.parse()) as Args;

	console.log(`[Processor] Initializing Spyglass for Minecraft ${argv.version}...`);
	const spyglass = await initSpyglass(argv.spyglassDir, argv.version);
	console.log(`[Processor] Spyglass initialized successfully.`);

	const inputPath = path.resolve(argv.input);
	const outputPath = path.resolve(argv.output);

	if (!fs.existsSync(inputPath)) {
		console.error(`[Error] Input path does not exist: ${inputPath}`);
		process.exit(1);
	}

	const options = {
		compressImages: argv.compressImages,
		minify: argv.minify,
		removeUnnecessary: argv.removeUnnecessary,
		autoLang: argv.autoLang,
		useHeuristic: argv.useHeuristic,
	};

	if (isSinglePack(inputPath)) {
		// For single pack, output directly to outputPath
		if (argv.forceOverwrite && fs.existsSync(outputPath)) {
			console.log(`[Processor] Force overwrite enabled. Deleting target directory: ${outputPath}`);
			fs.rmSync(outputPath, { recursive: true, force: true });
		}
		await processSinglePack(inputPath, outputPath, spyglass, argv.version, options);
	} else {
		console.log(`[Processor] Detecting multiple packs in directory: ${inputPath}`);
		const children = fs.readdirSync(inputPath);
		const packsToProcess: string[] = [];

		for (const child of children) {
			const childPath = path.join(inputPath, child);
			if (isSinglePack(childPath)) {
				packsToProcess.push(childPath);
			}
		}

		if (packsToProcess.length === 0) {
			console.log(`[Processor] No valid packs found under ${inputPath}.`);
			return;
		}

		console.log(`[Processor] Found ${packsToProcess.length} packs to process.`);
		for (const pack of packsToProcess) {
			const packName = path.basename(pack, '.zip');
			// For multiple packs, output to a subdirectory under outputPath
			const packOutPath = path.join(outputPath, packName);
			if (argv.forceOverwrite && fs.existsSync(packOutPath)) {
				console.log(`[Processor] Force overwrite enabled. Deleting target directory: ${packOutPath}`);
				fs.rmSync(packOutPath, { recursive: true, force: true });
			}
			try {
				await processSinglePack(pack, packOutPath, spyglass, argv.version, options);
			} catch (e: any) {
				console.error(`[Error] Failed to process pack ${path.basename(pack)}:`, e.message);
			}
		}
	}

	console.log('[Processor] All processing successfully finished!');

	await spyglass.project.close();
	process.exit(0);
}

function getSchemaPathForJson(relPath: string): string {
	const parts = relPath.split(path.sep);
	const dataIdx = parts.indexOf('data');
	if (dataIdx === -1 || dataIdx + 2 >= parts.length) {
		return '';
	}

	const category = parts[dataIdx + 2];
	switch (category) {
		case 'advancement':
			return '::java::data::advancement::Advancement';
		case 'loot_table':
			return '::java::data::loot::LootTable';
		case 'recipe':
			return '::java::data::recipe::Recipe';
		case 'item_modifier':
			return '::java::data::item_modifier::ItemModifier';
		case 'predicate':
			return '::java::data::predicate::Predicate';
		case 'enchantment':
			return '::java::data::enchantment::Enchantment';
		case 'damage_type':
			return '::java::data::damage_type::DamageType';
		default:
			return '';
	}
}

main().catch((err) => {
	console.error('[Fatal Error]', err);
	process.exit(1);
});
