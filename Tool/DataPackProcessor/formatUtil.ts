/**
 * Utility functions for consistent formatting across all processors.
 */

const re_is_technical_math_or_placeholder = /^(%(\d+\$)?([a-zA-Z]|%)_?|[+\-*/%&|^<>!=]=?)$/;
const cmd_prefixes = ['function ', 'execute ', 'scoreboard ', 'data ', 'tellraw ', 'title ', 'tag ', 'summon ', 'give ', 'tp ', 'teleport ', 'effect ', 'attribute ', 'advancement ', 'recipe ', 'item ', 'playsound ', 'bossbar ', 'fill ', 'setblock ', 'clone ', 'particle ', 'gamemode ', 'clear '];

/**
 * Filter Minecraft technical IDs, command templates, scoreboard selectors, and mathematical expressions.
 * Keeps parsing completely generalized to standard Minecraft patterns without third-party hardcoding.
 */
export function isTechnicalId(s: string): boolean {
	const s_strip = s.trim();
	if (!s_strip) return true;

	// Scoreboard selectors, triggers, and flags (e.g., @s, #eplus, $val, %timer)
	if (s_strip.startsWith('/') || s_strip.startsWith('$') || s_strip.startsWith('#') || s_strip.startsWith('%') || s_strip.startsWith('@')) {
		return true;
	}

	// Pure mathematical operators and parameter variables like %1$s
	if (re_is_technical_math_or_placeholder.test(s_strip)) {
		return true;
	}

	// Common Minecraft server commands
	if (cmd_prefixes.some((p) => s_strip.toLowerCase().startsWith(p))) {
		return true;
	}

	// Minecraft native namespaces (e.g. minecraft:stone)
	if (s_strip.startsWith('minecraft:')) {
		return true;
	}

	// General strict Minecraft ID format (namespace:path_slug)
	if (/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(s_strip)) {
		return true;
	}

	// Dot-separated technical words with no spaces (e.g. "item.axe.scrape", "entity.generic.eat")
	// Minecraft built-in identifiers, event descriptors, or sound registrations
	if (/^[a-z0-9_.-]+\.[a-z0-9_.-]+(\.[a-z0-9_.-]+)*$/.test(s_strip) && !s_strip.includes(' ')) {
		return true;
	}

	// Single word enums/identifiers with no spaces containing letters/underscores only,
	// representing options like "never", "default", "player", "arrow"
	if (/^[a-z0-9_]+$/.test(s_strip) && !s_strip.includes(' ') && s_strip.length < 25) {
		const enumWords = new Set(['never', 'default', 'player', 'arrow', 'always', 'by_player', 'true', 'false', 'none', 'trigger']);
		if (enumWords.has(s_strip)) {
			return true;
		}
	}

	return false;
}

/**
 * Clean text content to UTF-8, normalize CRLF to LF, and remove any trailing newline or carriage return characters.
 */
export function cleanToUtf8LfNoTrailingNewlines(content: string): string {
	if (content.length === 0) return '';
	// Normalize CRLF to LF, and strip all trailing LF or CR characters
	return content.replace(/\r\n/g, '\n').replace(/[\r\n]+$/, '');
}

/**
 * Ensure single trailing LF suffix.
 */
export function ensureSingleTrailingLFSuffix(content: string): string {
	if (content.length === 0) return '';
	return cleanToUtf8LfNoTrailingNewlines(content) + '\n';
}

/**
 * Match source trailing line ending by cleaning everything to UTF-8 LF and stripping trailing newlines.
 * This ensures that even if other functions change, processing results remain consistent.
 */
export function matchSourceTrailingLF(processedContent: string): string {
	return cleanToUtf8LfNoTrailingNewlines(processedContent);
}
