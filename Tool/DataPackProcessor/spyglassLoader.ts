import { createRequire } from 'module';
import { resolve } from 'path';

// Dynamically resolve package entry paths from the specified spyglassDir using Node's resolution mechanism.
// This completely removes raw folder-structure hardcoding, allowing seamless compatibility and dynamic loading.
export function getSpyglassModules(spyglassDir: string) {
	const resolvedSpyglassDir = resolve(process.cwd(), spyglassDir);
	const require = createRequire(import.meta.url);

	const resolvePkg = (pkgName: string) => {
		try {
			return require.resolve(pkgName, { paths: [resolvedSpyglassDir] });
		} catch (e: any) {
			throw new Error(`Failed to dynamically resolve Spyglass package '${pkgName}': ${e.message}`);
		}
	};

	return {
		corePath: resolvePkg('@spyglassmc/core'),
		mcdocPath: resolvePkg('@spyglassmc/mcdoc'),
		javaEditionPath: resolvePkg('@spyglassmc/java-edition'),
		jsonPath: resolvePkg('@spyglassmc/json'),
		nbtPath: resolvePkg('@spyglassmc/nbt'),
		mcfunctionPath: resolvePkg('@spyglassmc/mcfunction'),
		nodejsPath: resolvePkg('@spyglassmc/core/lib/nodejs.js'),
		textDocumentPath: resolvePkg('vscode-languageserver-textdocument'),
	};
}
