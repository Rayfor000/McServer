import * as crypto from 'crypto';
import * as path from 'path';

export class TranslationManager {
	private translations: Map<string, Map<string, string>> = new Map(); // langCode -> (key -> value)
	private keyToContext: Map<string, string> = new Map(); // key -> context description
	private valueToKey: Map<string, string> = new Map(); // value -> key (to reuse keys for identical values)
	private sourceLang: string = 'main';

	constructor() {}

	public setSourceLang(lang: string): void {
		this.sourceLang = 'main';
	}

	public getSourceLang(): string {
		return 'main';
	}

	/**
	 * Loads existing translations from a language JSON object.
	 */
	public loadExistingTranslations(langCode: string, langJson: Record<string, any>): void {
		const code = langCode.toLowerCase().trim();
		if (!this.translations.has(code)) {
			this.translations.set(code, new Map());
		}
		const langMap = this.translations.get(code)!;

		for (const [key, value] of Object.entries(langJson)) {
			if (typeof value === 'string') {
				langMap.set(key, value);
				if (code === this.sourceLang) {
					this.valueToKey.set(value, key);
				}
			}
		}
	}

	/**
	 * Generates a context-aware translation key.
	 * Format: [namespace].[category].[file_name].[json_path]
	 * If the key is too long or has duplicate conflicts, we append a short hash of the value.
	 */
	public generateKey(value: string, filePath: string, jsonPath: string[], namespace: string = 'minecraft'): string {
		const cleanValue = value.trim();
		if (!cleanValue) return '';

		// Extract file name without extension
		const parsedPath = path.parse(filePath);
		const fileName = parsedPath.name;

		// Determine category from path (e.g., loot_table, advancement, recipe)
		const pathParts = filePath.split(path.sep);
		let category = 'general';
		const dataIdx = pathParts.indexOf('data');
		if (dataIdx !== -1 && dataIdx + 2 < pathParts.length) {
			category = pathParts[dataIdx + 2];
		} else if (pathParts.includes('assets')) {
			const assetsIdx = pathParts.indexOf('assets');
			if (assetsIdx !== -1 && assetsIdx + 2 < pathParts.length) {
				category = pathParts[assetsIdx + 2];
			}
		}

		// Scope deduplication to the current file to preserve context-aware translation keys.
		// Use full filePath instead of fileName to prevent duplicate value clashing across identical file names in different folders.
		const fileScopeKey = `${filePath}:${cleanValue}`;
		if (this.valueToKey.has(fileScopeKey)) {
			return this.valueToKey.get(fileScopeKey)!;
		}

		// Clean up JSON path parts to be valid key segments
		const cleanJsonPath = jsonPath
			.map((p) => p.replace(/[^a-zA-Z0-9_]/g, '_'))
			.filter(Boolean)
			.join('.');

		// Construct base key
		let baseKey = `${namespace}.${category}.${fileName}`;
		if (cleanJsonPath) {
			baseKey += `.${cleanJsonPath}`;
		}

		// Lowercase and sanitize
		baseKey = baseKey.toLowerCase().replace(/[^a-z0-9_.]/g, '_');

		// Ensure key is not excessively long, but keep it readable
		if (baseKey.length > 80) {
			baseKey = baseKey.substring(0, 70);
		}

		// Append a short hash of the value to guarantee uniqueness and prevent collisions
		const hash = crypto.createHash('sha256').update(cleanValue).digest('hex').substring(0, 8);
		const finalKey = `${baseKey}.${hash}`;

		// Store translation in source language
		if (!this.translations.has(this.sourceLang)) {
			this.translations.set(this.sourceLang, new Map());
		}
		this.translations.get(this.sourceLang)!.set(finalKey, cleanValue);
		this.valueToKey.set(fileScopeKey, finalKey);

		// Store context description for translators
		const contextDesc = `File: ${filePath}, Path: ${jsonPath.join(' -> ')}`;
		this.keyToContext.set(finalKey, contextDesc);

		return finalKey;
	}

	public addTranslation(langCode: string, key: string, value: string, filePath: string, jsonPath: string[]): void {
		const code = langCode.toLowerCase().trim();
		if (!this.translations.has(code)) {
			this.translations.set(code, new Map());
		}
		this.translations.get(code)!.set(key, value);

		if (code === this.sourceLang) {
			this.valueToKey.set(value, key);
		}

		const contextDesc = `File: ${filePath}, Path: ${jsonPath.join(' -> ')}`;
		this.keyToContext.set(key, contextDesc);
	}

	public getTranslation(langCode: string, key: string): string | undefined {
		const code = langCode.toLowerCase().trim();
		return this.translations.get(code)?.get(key);
	}

	public getLanguageJson(langCode: string): Record<string, string> {
		const code = langCode.toLowerCase().trim();
		const result: Record<string, string> = {};
		const langMap = this.translations.get(code);
		if (langMap) {
			for (const [key, value] of langMap.entries()) {
				result[key] = value;
			}
		}
		return result;
	}

	public getLoadedLanguages(): string[] {
		return Array.from(this.translations.keys());
	}
}
