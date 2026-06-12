import { JsonProcessor } from './jsonProcessor.js';
import { SnbtProcessor } from './snbtProcessor.js';
import { SpyglassContext } from './spyglassProject.js';
import { TranslationManager } from './translationManager.js';

export class McfunctionProcessor {
	private snbtProcessor: SnbtProcessor;
	private jsonProcessor: JsonProcessor;

	constructor(
		private spyglass: SpyglassContext,
		private translationManager: TranslationManager,
	) {
		this.snbtProcessor = new SnbtProcessor(spyglass, translationManager);
		this.jsonProcessor = new JsonProcessor(spyglass, translationManager);
	}

	/**
	 * Preprocesses macro variables, unicode escapes, and unquoted lone macro variables
	 * to make SNBT/JSON parsing by Spyglass safe, returning a revert function to restore them.
	 */
	private preprocessJsonOrSnbt(jsonStr: string): {
		processed: string;
		revert: (s: string) => string;
	} {
		const macroReplacements: { placeholder: string; original: string }[] = [];
		const unicodeReplacements: { placeholder: string; original: string }[] = [];
		const loneMacroReplacements: { placeholder: string; original: string }[] = [];

		// 1. Preprocess unquoted lone macro variables in object NBT context
		// e.g., { ..., $(facing), ... } -> { ..., $(facing):true, ... }
		let processed = '';
		let i = 0;
		const n = jsonStr.length;
		const bracketStack: string[] = [];
		let inString: string | null = null;
		let escape = false;

		while (i < n) {
			const char = jsonStr[i];

			if (inString) {
				if (escape) {
					escape = false;
				} else if (char === '\\') {
					escape = true;
				} else if (char === inString) {
					inString = null;
				}
				processed += char;
				i++;
				continue;
			}

			if (char === '"' || char === "'") {
				inString = char;
				escape = false;
				processed += char;
				i++;
				continue;
			}

			if (char === '{') {
				bracketStack.push('{');
				processed += char;
				i++;
				continue;
			}
			if (char === '}') {
				if (bracketStack.length > 0 && bracketStack[bracketStack.length - 1] === '{') {
					bracketStack.pop();
				}
				processed += char;
				i++;
				continue;
			}
			if (char === '[') {
				bracketStack.push('[');
				processed += char;
				i++;
				continue;
			}
			if (char === ']') {
				if (bracketStack.length > 0 && bracketStack[bracketStack.length - 1] === '[') {
					bracketStack.pop();
				}
				processed += char;
				i++;
				continue;
			}

			if (char === '$' && i + 1 < n && jsonStr[i + 1] === '(') {
				// Find ending ')'
				let endIdx = i + 2;
				while (endIdx < n && jsonStr[endIdx] !== ')') {
					endIdx++;
				}
				if (endIdx < n && jsonStr[endIdx] === ')') {
					const macroFull = jsonStr.substring(i, endIdx + 1);
					const macroLen = macroFull.length;

					let prevIdx = i - 1;
					while (prevIdx >= 0 && /\s/.test(jsonStr[prevIdx])) {
						prevIdx--;
					}
					const isAfterColon = prevIdx >= 0 && jsonStr[prevIdx] === ':';

					let nextIdx = i + macroLen;
					while (nextIdx < n && /\s/.test(jsonStr[nextIdx])) {
						nextIdx++;
					}
					const isBeforeColon = nextIdx < n && jsonStr[nextIdx] === ':';

					const inObject = bracketStack.length > 0 && bracketStack[bracketStack.length - 1] === '{';

					if (inObject && !isAfterColon && !isBeforeColon) {
						processed += `${macroFull}:true`;
						loneMacroReplacements.push({
							placeholder: `${macroFull}:true`,
							original: macroFull,
						});
					} else {
						processed += macroFull;
					}

					i += macroLen;
					continue;
				}
			}

			processed += char;
			i++;
		}

		// 2. Safely escape unicode escape sequences \uXXXX to prevent decode loss
		let unicodeCounter = 0;
		processed = processed.replace(/\\u([0-9a-fA-F]{4})/g, (match, hex) => {
			const placeholder = `__UNICODE_HEX_${hex}_${unicodeCounter++}__`;
			unicodeReplacements.push({ placeholder, original: match });
			return placeholder;
		});

		// 3. Temporarily replace standard macro variables $(variable) with safe string placeholders
		let placeholderCounter = 0;
		processed = processed.replace(/\$\([a-zA-Z0-9_.-]+\)/g, (match) => {
			const placeholder = `"${match.replace(/[^a-zA-Z0-9]/g, '_')}_${placeholderCounter++}"`;
			macroReplacements.push({ placeholder, original: match });
			return placeholder;
		});

		const revert = (s: string): string => {
			let result = s;

			// Revert safe string placeholders back to macro variables
			for (const r of macroReplacements) {
				result = result.replace(new RegExp(r.placeholder, 'g'), r.original);
				// Also handle stripped quotes if any
				const unquotedPlaceholder = r.placeholder.slice(1, -1);
				result = result.replace(new RegExp(unquotedPlaceholder, 'g'), r.original);
			}

			// Revert lone macro variables back to unquoted formats
			for (const r of loneMacroReplacements) {
				result = result.replace(new RegExp(r.placeholder.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g'), r.original);
			}

			// Revert unicode escapes
			for (const r of unicodeReplacements) {
				result = result.replace(new RegExp(r.placeholder, 'g'), r.original);
			}

			return result;
		};

		return { processed, revert };
	}

	/**
	 * Processes an mcfunction file by scanning each line, extracting JSON and SNBT blocks,
	 * rewriting them, and returning the modified mcfunction content.
	 */
	public processMcfunction(content: string, filePath: string, namespace: string = 'minecraft', minify: boolean = false): { content: string; modified: boolean } {
		// Standardize line endings to LF before split
		const normalizedContent = content.replace(/\r\n/g, '\n');

		// Correct handling of backslash line continuations:
		// If a line ends with '\' (possibly followed by carriage returns or spaces), we join it with the next line
		// for processing as a single logical block, then restore the formatting after.
		// However, a simple approach is: we pre-process line continuations into temporary lines, or keep track of physical line breaks.
		// Let's implement a robust logical block joiner and splitter.
		const physicalLines = normalizedContent.split('\n');
		const logicalLines: { text: string; physicalLineIndices: number[] }[] = [];

		let currentLogical = '';
		let currentPhysicalIndices: number[] = [];

		for (let i = 0; i < physicalLines.length; i++) {
			const line = physicalLines[i];
			currentPhysicalIndices.push(i);

			// Check if line ends with '\'
			const trimmedLine = line.trimEnd();
			const endsWithBackslash = trimmedLine.endsWith('\\');
			if (endsWithBackslash) {
				// Strip the backslash and join with next physical line
				currentLogical += trimmedLine.slice(0, -1).trimEnd();
			} else {
				currentLogical += line;
				logicalLines.push({
					text: currentLogical,
					physicalLineIndices: currentPhysicalIndices,
				});
				currentLogical = '';
				currentPhysicalIndices = [];
			}
		}

		// Handle leftover if the file ends with a backslash
		if (currentPhysicalIndices.length > 0) {
			logicalLines.push({
				text: currentLogical,
				physicalLineIndices: currentPhysicalIndices,
			});
		}

		let modified = false;

		const processedLogicalLines = logicalLines.map(({ text: line, physicalLineIndices }) => {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) {
				return { original: true, physicalLineIndices };
			}

			let lineToProcess = line;
			let lineModified = false;

			// 1. Look for JSON blocks in commands (e.g., tellraw, title, etc.)
			// We can find JSON candidates by looking for matching curly braces or brackets
			const jsonCandidates = this.findJsonCandidates(lineToProcess);
			let currentLine = lineToProcess;

			// Process candidates from right to left to preserve character offsets
			for (const [start, end] of jsonCandidates.reverse()) {
				const jsonStr = currentLine.substring(start, end);
				try {
					const { processed: jsonStrPre, revert } = this.preprocessJsonOrSnbt(jsonStr);

					// Try to process as a Text Component JSON
					let { content: processedJson, modified: jsonMod } = this.jsonProcessor.processJson(jsonStrPre, filePath, '::java::server::util::text::Text', namespace, minify);

					// Fallback removed to enforce strict schema-based JSON processing

					if (jsonMod) {
						const revertedJson = revert(processedJson);
						currentLine = currentLine.substring(0, start) + revertedJson + currentLine.substring(end);
						lineModified = true;
						modified = true;
					}
				} catch (e: any) {
					console.error('[mcfunctionProcessor debug] jsonProcessor error:', e.message, e.stack);
				}
			}

			// 2. Look for SNBT blocks in commands (e.g., give, summon, data merge, etc.)
			// SNBT blocks usually start with '{' and end with '}' and are not valid JSON (e.g., unquoted keys, type suffixes)
			const snbtCandidates = this.findSnbtCandidates(currentLine);
			for (const [start, end] of snbtCandidates.reverse()) {
				const snbtStr = currentLine.substring(start, end);
				try {
					const { processed: snbtStrPre, revert } = this.preprocessJsonOrSnbt(snbtStr);

					let { content: processedSnbt, modified: snbtMod } = this.snbtProcessor.processSnbt(
						snbtStrPre,
						filePath,
						'::java::server::util::text::Text', // Fallback to text component schema
						namespace,
					);

					// Fallback removed to enforce strict schema-based SNBT processing

					if (snbtMod) {
						const revertedSnbt = revert(processedSnbt);
						currentLine = currentLine.substring(0, start) + revertedSnbt + currentLine.substring(end);
						lineModified = true;
						modified = true;
					}
				} catch (e) {
					// Not a valid SNBT, ignore
				}
			}

			return {
				line: currentLine,
				original: !lineModified,
				physicalLineIndices,
			};
		});

		// Now we reconstruct physical lines in order
		const finalPhysicalLines: string[] = [];

		processedLogicalLines.forEach((item) => {
			if (item.original) {
				// Direct output from the physical lines to avoid collapsing un-modified files or stripping backslashes
				item.physicalLineIndices.forEach((idx) => {
					finalPhysicalLines.push(physicalLines[idx].replace(/\r/g, ''));
				});
			} else {
				// Logical line was modified. Collapse any multi-line formatting (like formatted JSON) into a single line!
				// We replace newlines and any extra spacing with a single line representation.
				const collapsedLine = item.line!.replace(/\r?\n/g, '').replace(/\s+/g, ' ').trim();
				finalPhysicalLines.push(collapsedLine);
			}
		});

		return {
			content: finalPhysicalLines.join('\n'),
			modified,
		};
	}

	/**
	 * Finds potential JSON substrings in a command line.
	 */
	private findJsonCandidates(s: string): [number, number][] {
		const candidates: [number, number][] = [];
		let depth = 0;
		let startIdx = -1;
		let inString: string | null = null;

		for (let i = 0; i < s.length; i++) {
			const char = s[i];
			if (inString) {
				if (char === inString && s[i - 1] !== '\\') {
					inString = null;
				}
				continue;
			}

			if (char === '"' || char === "'") {
				inString = char;
				continue;
			}

			if (char === '{' || char === '[') {
				if (depth === 0) {
					startIdx = i;
				}
				depth++;
			} else if (char === '}' || char === ']') {
				if (depth > 0) {
					depth--;
					if (depth === 0 && startIdx !== -1) {
						candidates.push([startIdx, i + 1]);
					}
				}
			}
		}

		return candidates;
	}

	/**
	 * Finds potential SNBT substrings in a command line.
	 * SNBT blocks are typically enclosed in curly braces `{}`.
	 */
	private findSnbtCandidates(s: string): [number, number][] {
		const candidates: [number, number][] = [];
		let depth = 0;
		let startIdx = -1;
		let inString: string | null = null;

		for (let i = 0; i < s.length; i++) {
			const char = s[i];
			if (inString) {
				if (char === inString && s[i - 1] !== '\\') {
					inString = null;
				}
				continue;
			}

			if (char === '"' || char === "'") {
				inString = char;
				continue;
			}

			if (char === '{') {
				if (depth === 0) {
					startIdx = i;
				}
				depth++;
			} else if (char === '}') {
				if (depth > 0) {
					depth--;
					if (depth === 0 && startIdx !== -1) {
						candidates.push([startIdx, i + 1]);
					}
				}
			}
		}

		return candidates;
	}
}
