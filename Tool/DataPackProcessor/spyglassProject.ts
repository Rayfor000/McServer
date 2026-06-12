import { resolve } from 'path';
import { pathToFileURL } from 'url';
import { getSpyglassModules } from './spyglassLoader.js';

export interface SpyglassContext {
	core: any;
	mcdoc: any;
	javaEdition: any;
	json: any;
	nbt: any;
	mcfunction: any;
	project: any;
	mcdocTypes: Map<string, any>;
	mcdocDispatchers: Map<string, Map<string, any>>;
	TextDocument: any;
}

export async function initSpyglass(spyglassDir: string, minecraftVersion: string): Promise<SpyglassContext> {
	const modules = getSpyglassModules(spyglassDir);

	// Dynamically import the compiled Spyglass modules via resolved entrypoints
	const core = await import(pathToFileURL(modules.corePath).toString());
	const mcdoc = await import(pathToFileURL(modules.mcdocPath).toString());
	const javaEdition = await import(pathToFileURL(modules.javaEditionPath).toString());
	const json = await import(pathToFileURL(modules.jsonPath).toString());
	const nbt = await import(pathToFileURL(modules.nbtPath).toString());
	const mcfunction = await import(pathToFileURL(modules.mcfunctionPath).toString());

	// Import NodeJsExternals and TextDocument using dynamic resolved node pathing
	const { NodeJsExternals } = await import(pathToFileURL(modules.nodejsPath).toString());

	const { TextDocument } = await import(pathToFileURL(modules.textDocumentPath).toString());

	const logger = {
		log: () => {},
		info: () => {},
		warn: (...args: any[]) => console.warn('[Spyglass Warn]', ...args),
		error: (...args: any[]) => console.error('[Spyglass Error]', ...args),
	};

	const cacheRoot = resolve(process.cwd(), '.cache');
	const projectRoot = resolve(process.cwd(), spyglassDir);

	// Create a Spyglass Project instance
	const project = new core.Project({
		logger,
		profilers: new core.ProfilerFactory(logger, []),
		cacheRoot: core.fileUtil.ensureEndingSlash(pathToFileURL(cacheRoot).toString()),
		defaultConfig: core.ConfigService.merge(core.VanillaConfig, {
			env: {
				dependencies: ['@vanilla-mcdoc'],
				gameVersion: minecraftVersion,
			},
		}),
		externals: NodeJsExternals,
		initializers: [mcdoc.initialize, javaEdition.initialize, json.getInitializer(), nbt.initialize, mcfunction.initialize],
		projectRoots: [core.fileUtil.ensureEndingSlash(pathToFileURL(projectRoot).toString())],
	});

	// Initialize and wait for project to be ready (this compiles mcdoc schemas)
	await project.init();
	await project.ready();

	// Extract compiled mcdoc types and dispatchers
	const mcdocTypes = new Map<string, any>();
	const mcdocDispatchers = new Map<string, Map<string, any>>();

	const symbols = project.symbols.getVisibleSymbols('mcdoc');
	for (const [name, symbol] of Object.entries(symbols)) {
		if (mcdoc.binder.TypeDefSymbolData.is((symbol as any).data)) {
			mcdocTypes.set(name, (symbol as any).data.typeDef);
		}
	}

	const dispatchers = project.symbols.getVisibleSymbols('mcdoc/dispatcher');
	for (const [name, symbol] of Object.entries(dispatchers)) {
		const dispatcherMap = new Map<string, any>();
		mcdocDispatchers.set(name, dispatcherMap);
		for (const [id, member] of Object.entries((symbol as any).members ?? {})) {
			if (mcdoc.binder.TypeDefSymbolData.is((member as any).data)) {
				dispatcherMap.set(id, (member as any).data.typeDef);
			}
		}
	}

	return {
		core,
		mcdoc,
		javaEdition,
		json,
		nbt,
		mcfunction,
		project,
		mcdocTypes,
		mcdocDispatchers,
		TextDocument,
	};
}
