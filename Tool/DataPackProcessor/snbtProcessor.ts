import { isTechnicalId } from './formatUtil.js';
import { SpyglassContext } from './spyglassProject.js';
import { TranslationManager } from './translationManager.js';

export class SnbtProcessor {
	constructor(
		private spyglass: SpyglassContext,
		private translationManager: TranslationManager,
	) {}

	/**
	 * Parses an SNBT string into a Spyglass AST, processes it using mcdoc schemas,
	 * and returns the modified SNBT string.
	 */
	public processSnbt(
		content: string,
		filePath: string,
		mcdocTypePath: string, // e.g., '::java::server::util::text::Text' or custom struct
		namespace: string = 'minecraft',
	): { content: string; modified: boolean } {
		const { core, nbt, project } = this.spyglass;

		// 1. Parse SNBT into AST
		const parserSource = new core.Source(content);
		const parserCtx = core.ParserContext.create(project, {
			doc: this.spyglass.TextDocument.create('temp.snbt', 'snbt', 0, content),
		});
		const rootNode = nbt.parser.entry(parserSource, parserCtx);

		if (!rootNode) {
			return { content, modified: false };
		}

		// 2. Retrieve the root mcdoc type definition
		const rootType = this.spyglass.mcdocTypes.get(mcdocTypePath);
		let modified = false;

		// 3. Traverse AST with Schema
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
						if (accessor && node && node.type === 'nbt:compound' && Array.isArray(node.children)) {
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
		const processTextComponent = (node: any, jsonPath: string[]) => {
			if (!node) return;
			if (node.type === 'nbt:list') {
				if (Array.isArray(node.children)) {
					node.children.forEach((item: any, idx: number) => {
						processTextComponent(item, [...jsonPath, idx.toString()]);
					});
				}
				return;
			}
			if (node.type === 'nbt:string') {
				const rawValue = node.value;
				if (rawValue && rawValue.trim() && !isTechnicalId(rawValue)) {
					// Check if the string is actually a JSON-like string (nested JSON in NBT)
					const trimmed = rawValue.trim();
					if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
						// It's a nested JSON string! We should parse and process it recursively.
						const key = this.translationManager.generateKey(rawValue, filePath, jsonPath, namespace);

						// For SNBT, we can rewrite it as a JSON-like structure or keep it as a translated string
						// Let's rewrite the string value to be a JSON string containing translate/fallback
						const nestedJson = {
							translate: key,
							fallback: rawValue,
						};
						node.value = JSON.stringify(nestedJson);
						modified = true;
					} else {
						// Standard plain text component
						const key = this.translationManager.generateKey(rawValue, filePath, jsonPath, namespace);

						// In SNBT, we can rewrite a plain string to a compound: {translate: "key", fallback: "rawValue"}
						const compoundNode = {
							type: 'nbt:compound',
							range: node.range,
							children: [
								{
									type: 'pair',
									range: node.range,
									key: {
										type: 'nbt:string',
										value: 'translate',
										range: node.range,
									},
									value: {
										type: 'nbt:string',
										value: key,
										range: node.range,
									},
								},
								{
									type: 'pair',
									range: node.range,
									key: {
										type: 'nbt:string',
										value: 'fallback',
										range: node.range,
									},
									value: {
										type: 'nbt:string',
										value: rawValue,
										range: node.range,
									},
								},
							],
						};
						Object.assign(node, compoundNode);
						modified = true;
					}
				}
			} else if (node.type === 'nbt:compound' && Array.isArray(node.children)) {
				// If it's already a compound, check if it has "text" key
				const textPair = node.children.find((p: any) => p && p.key && p.key.value === 'text');
				if (textPair && textPair.value && textPair.value.type === 'nbt:string') {
					const rawValue = textPair.value.value;
					if (rawValue && rawValue.trim() && !isTechnicalId(rawValue)) {
						const key = this.translationManager.generateKey(rawValue, filePath, jsonPath, namespace);

						node.children = node.children.filter((p: any) => p !== textPair);
						const typePair = node.children.find((p: any) => p && p.key && (p.key.value === 'type' || p.key === 'type'));
						if (typePair && typePair.value && typePair.value.type === 'nbt:string' && typePair.value.value === 'text') {
							typePair.value.value = 'translatable';
						}
						node.children.push({
							type: 'pair',
							range: node.range,
							key: {
								type: 'nbt:string',
								value: 'translate',
								range: node.range,
							},
							value: { type: 'nbt:string', value: key, range: node.range },
						});
						node.children.push({
							type: 'pair',
							range: node.range,
							key: {
								type: 'nbt:string',
								value: 'fallback',
								range: node.range,
							},
							value: {
								type: 'nbt:string',
								value: rawValue,
								range: node.range,
							},
						});
						modified = true;
					}
				}
			}
		};

		const traverse = (node: any, typeDef: any, jsonPath: string[]) => {
			if (!node || !typeDef) return;

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

			// Check if this type is a Text Component
			const isTextComponent = (typeDef.path && (typeDef.path.endsWith('::text::Text') || typeDef.path.endsWith('::text::TextObject') || typeDef.path.endsWith('::util::text::Text') || typeDef.path.endsWith('::util::text::TextObject'))) || (typeDef.attributes && typeDef.attributes.some((attr: any) => attr.name === 'text_component'));

			if (isTextComponent) {
				processTextComponent(node, jsonPath);
				return;
			}

			// Recurse into compounds
			if (node.type === 'nbt:compound' && typeDef.kind === 'struct' && Array.isArray(node.children)) {
				for (const pair of node.children) {
					if (!pair || !pair.key || !pair.value) continue;
					const keyStr = pair.key.value;

					const field = findFieldInStruct(typeDef, keyStr, node);
					if (field && field.type) {
						traverse(pair.value, field.type, [...jsonPath, keyStr]);
					}
				}
			}

			// Recurse into lists
			if (node.type === 'nbt:list' && typeDef.kind === 'list' && Array.isArray(node.children)) {
				node.children.forEach((item: any, idx: number) => {
					traverse(item, typeDef.item, [...jsonPath, idx.toString()]);
				});
			}
		};

		if (rootType) {
			traverse(rootNode, rootType, []);
		} else {
			return { content, modified: false };
		}

		if (!modified) {
			return { content, modified: false };
		}

		const serialized = this.serializeNbtNode(rootNode);
		return { content: serialized, modified: true };
	}

	/**
	 * Serializes a Spyglass NBT AST node back to an SNBT string.
	 */
	private serializeNbtNode(node: any): string {
		if (!node) return '';

		switch (node.type) {
			case 'nbt:compound': {
				if (!node.children || !Array.isArray(node.children) || node.children.length === 0) return '{}';
				const pairs = node.children.map((pair: any) => {
					if (!pair || !pair.key || !pair.value) return '';
					const key = this.escapeNbtKey(pair.key.value);
					const val = this.serializeNbtNode(pair.value);
					return `${key}:${val}`;
				});
				return `{${pairs.filter(Boolean).join(',')}}`;
			}
			case 'nbt:list': {
				if (!node.children || !Array.isArray(node.children) || node.children.length === 0) return '[]';
				const items = node.children.map((item: any) => this.serializeNbtNode(item));
				return `[${items.filter(Boolean).join(',')}]`;
			}
			case 'nbt:string':
				return JSON.stringify(node.value);
			case 'nbt:byte':
				return `${node.value}b`;
			case 'nbt:short':
				return `${node.value}s`;
			case 'nbt:int':
				return `${node.value}`;
			case 'nbt:long':
				return `${node.value}L`;
			case 'nbt:float':
				return `${node.value}f`;
			case 'nbt:double':
				return `${node.value}d`;
			case 'nbt:byte_array':
				return `[B;${node.children.map((c: any) => c.value).join(',')}]`;
			case 'nbt:int_array':
				return `[I;${node.children.map((c: any) => c.value).join(',')}]`;
			case 'nbt:long_array':
				return `[L;${node.children.map((c: any) => c.value).join(',')}]`;
			default:
				return '';
		}
	}

	private escapeNbtKey(key: string): string {
		if (/^[a-zA-Z0-9_.-]+$/.test(key)) {
			return key;
		}
		return JSON.stringify(key);
	}
}
