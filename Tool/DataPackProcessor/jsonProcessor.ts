import { isTechnicalId } from './formatUtil.js';
import { SpyglassContext } from './spyglassProject.js';
import { TranslationManager } from './translationManager.js';

export class JsonProcessor {
	constructor(
		private spyglass: SpyglassContext,
		private translationManager: TranslationManager,
	) {}

	private mutateNodeToTranslate(node: any, key: string, rawValue: string) {
		const objNode = {
			type: 'json:object',
			range: node.range,
			children: [
				{
					type: 'pair',
					range: node.range,
					key: { type: 'json:string', value: 'translate', range: node.range },
					value: { type: 'json:string', value: key, range: node.range },
				},
				{
					type: 'pair',
					range: node.range,
					key: { type: 'json:string', value: 'fallback', range: node.range },
					value: { type: 'json:string', value: rawValue, range: node.range },
				},
			],
		};
		Object.assign(node, objNode);
	}

	private convertTextObjectToTranslate(node: any, textPair: any, key: string, rawValue: string) {
		node.children = node.children.filter((p: any) => p !== textPair);
		node.children.push({
			type: 'pair',
			range: node.range,
			key: { type: 'json:string', value: 'translate', range: node.range },
			value: { type: 'json:string', value: key, range: node.range },
		});
		node.children.push({
			type: 'pair',
			range: node.range,
			key: { type: 'json:string', value: 'fallback', range: node.range },
			value: { type: 'json:string', value: rawValue, range: node.range },
		});

		const typePair = node.children.find((p: any) => p && p.key && p.key.value === 'type');
		if (typePair && typePair.value && typePair.value.value === 'text') {
			typePair.value.value = 'translatable';
		}
	}

	/**
	 * Parses a JSON string into a Spyglass AST, processes it using mcdoc schemas,
	 * and returns the modified JSON string.
	 */
	public processJson(
		content: string,
		filePath: string,
		mcdocTypePath: string, // e.g., '::java::server::world::loot::LootTable'
		namespace: string = 'minecraft',
		minify: boolean = false,
	): { content: string; modified: boolean } {
		const { core, json, project, TextDocument } = this.spyglass;

		// 1. Parse JSON into AST
		const parserSource = new core.Source(content);
		const parserCtx = core.ParserContext.create(project, {
			doc: TextDocument.create('temp.json', 'json', 0, content),
		});
		const fileNode = json.parser.file(parserSource, parserCtx);

		if (!fileNode || !fileNode.children || fileNode.children.length === 0) {
			return { content, modified: false };
		}

		const rootNode = fileNode.children[0];

		// 2. Retrieve the root mcdoc type definition
		const rootType = this.spyglass.mcdocTypes.get(mcdocTypePath);
		if (!rootType) {
			return { content, modified: false };
		}

		// 3. Traverse AST with Schema
		let modified = false;

		const findFieldInStruct = (structDef: any, keyStr: string, node: any): any => {
			if (!structDef || !structDef.fields) return null;
			for (const field of structDef.fields) {
				if (field.kind === 'pair') {
					if (field.key === keyStr || (field.key && field.key.value === keyStr)) {
						return field;
					}
				} else if (field.kind === 'spread') {
					let spreadType = field.type;
					if (spreadType && spreadType.kind === 'reference') {
						spreadType = this.spyglass.mcdocTypes.get(spreadType.path);
					}
					if (spreadType && spreadType.kind === 'dispatcher') {
						const accessor = spreadType.parallelIndices?.[0]?.accessor?.[0];
						if (accessor && node && node.type === 'json:object' && Array.isArray(node.children)) {
							const accessorPair = node.children.find((p: any) => p && p.key && p.key.value === accessor);
							if (accessorPair && accessorPair.value) {
								let val = accessorPair.value.value;
								if (val) {
									if (val.startsWith('minecraft:')) val = val.substring('minecraft:'.length);
									const dispMap = this.spyglass.mcdocDispatchers.get(spreadType.registry);
									let matchedType = dispMap?.get(val);
									if (matchedType) {
										if (matchedType.kind === 'reference') {
											matchedType = this.spyglass.mcdocTypes.get(matchedType.path);
										}
										if (matchedType && matchedType.kind === 'struct') {
											const found = findFieldInStruct(matchedType, keyStr, node);
											if (found) return found;
										}
									}
								}
							}
						}
					}
					if (spreadType && spreadType.kind === 'struct') {
						const found = findFieldInStruct(spreadType, keyStr, node);
						if (found) return found;
					}
				}
			}
			return null;
		};

		// Helper to rewrite translate+fallback for both processJson and processJsonHeuristic to keep logic clean and DRY
		const alignOrRewriteTranslateStructure = (node: any, path: string[]): boolean => {
			if (!node || node.type !== 'json:object' || !Array.isArray(node.children)) return false;
			const translatePair = node.children.find((p: any) => p && p.key && p.key.value === 'translate');
			const fallbackPair = node.children.find((p: any) => p && p.key && p.key.value === 'fallback');

			if (translatePair && translatePair.value && translatePair.value.type === 'json:string' && fallbackPair && fallbackPair.value && fallbackPair.value.type === 'json:string') {
				const rawValue = fallbackPair.value.value;
				if (rawValue && rawValue.trim() && !isTechnicalId(rawValue)) {
					const key = this.translationManager.generateKey(rawValue, filePath, path, namespace);
					if (translatePair.value.value !== key) {
						translatePair.value.value = key;
						return true;
					}
				}
			}
			return false;
		};

		const processTextComponent = (node: any, jsonPath: string[]) => {
			if (!node) return;
			if (node.type === 'item') {
				processTextComponent(node.value, jsonPath);
				return;
			}
			if (node.type === 'json:array') {
				if (Array.isArray(node.children)) {
					node.children.forEach((item: any, idx: number) => {
						processTextComponent(item, [...jsonPath, idx.toString()]);
					});
				}
				return;
			}
			// If it's a string node, rewrite it to a translate/fallback object
			if (node.type === 'json:string') {
				const rawValue = node.value;
				if (rawValue && rawValue.trim() && !isTechnicalId(rawValue)) {
					const key = this.translationManager.generateKey(rawValue, filePath, jsonPath, namespace);
					this.mutateNodeToTranslate(node, key, rawValue);
					modified = true;
				}
			} else if (node.type === 'json:object' && Array.isArray(node.children)) {
				// First check: does it already have "translate" AND "fallback" keys?
				if (alignOrRewriteTranslateStructure(node, jsonPath)) {
					modified = true;
					return;
				}

				// If it's already an object, check if it has "text" key
				const textPair = node.children.find((p: any) => p && p.key && p.key.value === 'text');
				if (textPair && textPair.value && textPair.value.type === 'json:string') {
					const rawValue = textPair.value.value;
					if (rawValue && rawValue.trim() && !isTechnicalId(rawValue)) {
						const key = this.translationManager.generateKey(rawValue, filePath, jsonPath, namespace);
						this.convertTextObjectToTranslate(node, textPair, key, rawValue);
						modified = true;
					}
				}
			}
		};

		const traverse = (node: any, typeDef: any, jsonPath: string[]) => {
			if (!node || !typeDef) return;

			if (node.type === 'item') {
				traverse(node.value, typeDef, jsonPath);
				return;
			}

			// Handle unions
			if (typeDef.kind === 'union') {
				for (const member of typeDef.members || []) {
					traverse(node, member, jsonPath);
				}
				return;
			}

			// Handle references
			if (typeDef.kind === 'reference') {
				const isTextComponent = typeDef.path && (typeDef.path.endsWith('::text::Text') || typeDef.path.endsWith('::text::TextObject') || typeDef.path.endsWith('::util::text::Text') || typeDef.path.endsWith('::util::text::TextObject'));

				if (isTextComponent) {
					processTextComponent(node, jsonPath);
					return;
				}

				const refType = this.spyglass.mcdocTypes.get(typeDef.path);
				if (refType) {
					traverse(node, refType, jsonPath);
				}
				return;
			}

			// Check if this type is a Text Component (either by path or attribute)
			const isTextComponent = (typeDef.path && (typeDef.path.endsWith('::text::Text') || typeDef.path.endsWith('::text::TextObject') || typeDef.path.endsWith('::util::text::Text') || typeDef.path.endsWith('::util::text::TextObject'))) || (typeDef.attributes && typeDef.attributes.some((attr: any) => attr.name === 'text_component'));

			if (isTextComponent) {
				processTextComponent(node, jsonPath);
				return;
			}

			// Recurse into objects
			if (node.type === 'json:object' && typeDef.kind === 'struct' && Array.isArray(node.children)) {
				for (const pair of node.children) {
					if (!pair || !pair.key || !pair.value) continue;
					const keyStr = pair.key.value;

					const field = findFieldInStruct(typeDef, keyStr, node);
					if (field && field.type) {
						traverse(pair.value, field.type, [...jsonPath, keyStr]);
					}
				}
			}

			// Recurse into arrays
			if (node.type === 'json:array' && typeDef.kind === 'list' && Array.isArray(node.children)) {
				node.children.forEach((item: any, idx: number) => {
					traverse(item, typeDef.item, [...jsonPath, idx.toString()]);
				});
			}
		};

		traverse(rootNode, rootType, []);

		if (!modified) {
			return { content, modified: false };
		}

		// 4. Serialize AST back to JSON string
		const serialized = this.serializeJsonNode(rootNode, minify ? null : '');
		return { content: serialized, modified: true };
	}

	/**
	 * Fallback heuristic-based processor when no schema is available.
	 * Traverses the JSON AST, translating string values and checking text components.
	 */
	public processJsonHeuristic(content: string, filePath: string, namespace: string = 'minecraft', minify: boolean = false): { content: string; modified: boolean } {
		const { core, json, project, TextDocument } = this.spyglass;

		const parserSource = new core.Source(content);
		const parserCtx = core.ParserContext.create(project, {
			doc: TextDocument.create('temp.json', 'json', 0, content),
		});
		const fileNode = json.parser.file(parserSource, parserCtx);

		if (!fileNode || !fileNode.children || fileNode.children.length === 0) {
			return { content, modified: false };
		}

		const rootNode = fileNode.children[0];
		let modified = false;

		// Set of keys we should never translate as they are system parameters
		const reservedKeys = new Set(['id', 'type', 'trigger', 'item', 'tag', 'to_apply', 'condition', 'conditions', 'pools', 'entries', 'functions', 'pool', 'enchanted', 'affected', 'slot', 'mode', 'dimension', 'criteria', 'parent', 'requirements', 'predicate', 'translate', 'fallback', 'profile', 'recipes', 'template', 'entry', 'function', 'storage', 'objective', 'score', 'italic', 'bold', 'color', 'underlined', 'strikethrough', 'obfuscated', 'font', 'operation', 'scaling', 'sound', 'sound_id', 'message_id', 'death_message_type', 'range', 'volume', 'pitch']);

		// Helper to rewrite translate+fallback for both processJson and processJsonHeuristic to keep logic clean and DRY
		const alignOrRewriteTranslateStructure = (node: any, path: string[]): boolean => {
			if (!node || node.type !== 'json:object' || !Array.isArray(node.children)) return false;
			const translatePair = node.children.find((p: any) => p && p.key && p.key.value === 'translate');
			const fallbackPair = node.children.find((p: any) => p && p.key && p.key.value === 'fallback');

			if (translatePair && translatePair.value && translatePair.value.type === 'json:string' && fallbackPair && fallbackPair.value && fallbackPair.value.type === 'json:string') {
				const rawValue = fallbackPair.value.value;
				if (rawValue && rawValue.trim() && !isTechnicalId(rawValue)) {
					const key = this.translationManager.generateKey(rawValue, filePath, path, namespace);
					if (translatePair.value.value !== key) {
						translatePair.value.value = key;
						return true;
					}
				}
			}
			return false;
		};

		const traverseHeuristic = (node: any, jsonPath: string[], parentKey: string = '') => {
			if (!node) return;

			if (node.type === 'item') {
				traverseHeuristic(node.value, jsonPath, parentKey);
				return;
			}

			if (node.type === 'json:object' && Array.isArray(node.children)) {
				// 1. First check: does it already have "translate" AND "fallback" keys?
				if (alignOrRewriteTranslateStructure(node, jsonPath)) {
					modified = true;
					return;
				}

				// 2. Check for "text" component
				const textPair = node.children.find((p: any) => p && p.key && p.key.value === 'text');
				if (textPair && textPair.value && textPair.value.type === 'json:string') {
					const rawValue = textPair.value.value;
					if (rawValue && rawValue.trim() && !isTechnicalId(rawValue)) {
						const key = this.translationManager.generateKey(rawValue, filePath, jsonPath, namespace);
						this.convertTextObjectToTranslate(node, textPair, key, rawValue);
						modified = true;
					}
					return;
				}

				// Otherwise recurse into all children pairs
				for (const pair of node.children) {
					if (!pair || !pair.key || !pair.value) continue;
					const keyStr = pair.key.value;

					if (reservedKeys.has(keyStr) || keyStr.includes('custom_data') || keyStr.includes('custom_model_data')) {
						continue;
					}

					// If the child is a raw string value, check if we should translate it directly
					if (pair.value.type === 'json:string') {
						const rawValue = pair.value.value;
						if (rawValue && rawValue.trim() && !isTechnicalId(rawValue)) {
							const key = this.translationManager.generateKey(rawValue, filePath, [...jsonPath, keyStr], namespace);
							this.mutateNodeToTranslate(pair.value, key, rawValue);
							modified = true;
						}
					} else {
						traverseHeuristic(pair.value, [...jsonPath, keyStr], keyStr);
					}
				}
			} else if (node.type === 'json:array' && Array.isArray(node.children)) {
				node.children.forEach((item: any, idx: number) => {
					traverseHeuristic(item, [...jsonPath, idx.toString()], parentKey);
				});
			}
		};

		traverseHeuristic(rootNode, []);

		if (!modified) {
			return { content, modified: false };
		}

		const serialized = this.serializeJsonNode(rootNode, minify ? null : '');
		return { content: serialized, modified: true };
	}

	/**
	 * Serializes a Spyglass JSON AST node back to a formatted JSON string.
	 */
	private serializeJsonNode(node: any, indent: string | null = ''): string {
		if (!node) return 'null';
		const isMinify = indent === null;

		switch (node.type) {
			case 'json:object': {
				if (!node.children || !Array.isArray(node.children) || node.children.length === 0) return '{}';
				const nextIndent = isMinify ? null : indent + '  ';
				const pairs = node.children.map((pair: any) => {
					if (!pair || !pair.key || !pair.value) return '';
					const key = JSON.stringify(pair.key.value);
					const val = this.serializeJsonNode(pair.value, nextIndent);
					return isMinify ? `${key}:${val}` : `${nextIndent}${key}: ${val}`;
				});
				return isMinify ? `{${pairs.filter(Boolean).join(',')}}` : `{\n${pairs.join(',\n')}\n${indent}}`;
			}
			case 'json:array': {
				if (!node.children || !Array.isArray(node.children) || node.children.length === 0) return '[]';
				const nextIndent = isMinify ? null : indent + '  ';
				const items = node.children.map((item: any) => {
					return isMinify ? this.serializeJsonNode(item, nextIndent) : `${nextIndent}${this.serializeJsonNode(item, nextIndent)}`;
				});
				return isMinify ? `[${items.join(',')}]` : `[\n${items.join(',\n')}\n${indent}]`;
			}
			case 'item':
				return this.serializeJsonNode(node.value, indent);
			case 'json:string':
				return JSON.stringify(node.value);
			case 'json:number':
				return node.value.value.toString();
			case 'json:boolean':
				return (
					typeof node.value === 'object' && node.value !== null ?
						node.value.value ?
							'true'
						:	'false'
					: node.value ? 'true'
					: 'false'
				);
			case 'json:null':
				return 'null';
			default:
				console.log(`[serializeJsonNode] Unknown node type: ${node.type}`, node);
				return 'null';
		}
	}
}
