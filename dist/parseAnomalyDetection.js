/**
 * parseAnomalyDetection.ts — Detection for files processed but emitting zero definitions.
 *
 * Extracted from the indexing pipeline to provide a permanent regression guard.
 * Files matching the anomaly criteria are counted and sampled for `index_status` output.
 */
const MIN_LINES_FOR_ANOMALY_CHECK = 30;
/**
 * Filename patterns for config/tooling files that legitimately have zero
 * definitions. These files parse cleanly but are pure-config objects that do
 * not export named functions — they are false positives for the anomaly check.
 *
 * The patterns cover:
 *   - Generic *.config.{js,ts,cjs,mjs} (vitest.config.ts, jest.config.js, …)
 *   - .dependency-cruiser.{cjs,js,mjs,ts} (dot-prefixed convention)
 *   - Hook scripts in .claude/hooks/ (*.mjs, *.js in a hooks directory)
 */
const CONFIG_FILENAME_PATTERNS = [
    /\.config\.[cm]?[jt]s$/,
    /(?:^|[\\/])\.dependency-cruiser\.[cm]?[jt]s$/,
    /(?:^|[\\/])vitest\.config\.[cm]?[jt]s$/,
    /(?:^|[\\/])jest\.config\.[cm]?[jt]s$/,
];
/** Returns true when the relative path matches a known config-file pattern. */
function isKnownConfigFile(relativePath) {
    return CONFIG_FILENAME_PATTERNS.some((re) => re.test(relativePath));
}
/**
 * Counts files where:
 *   - parsed != null (file was processed, not unreadable)
 *   - parsed.definitions.length === 0 (no definitions emitted)
 *   - lineCount > MIN_LINES_FOR_ANOMALY_CHECK (exclude small config/index barrels)
 *   - exportedNames.length === 0 (exclude pure re-export barrels)
 *   - NOT a pure data-config object (zero definitions AND zero calls AND zero imports)
 *   - NOT matching a known config filename pattern
 *
 * Returns count + the complete sorted list of anomalous relative paths.
 */
export function countParseAnomalies(indexedFiles) {
    const anomalies = [];
    for (const file of indexedFiles) {
        if (file.parsed === null)
            continue;
        if (file.parsed.definitions.length > 0)
            continue;
        if (file.parsed.lineCount <= MIN_LINES_FOR_ANOMALY_CHECK)
            continue;
        if (file.parsed.exportedNames.length > 0)
            continue;
        // Suppress pure data-config objects: files with zero definitions that also
        // have no calls and no imports are plain object literals / config defaults —
        // not a parser regression, just a legitimate zero-definition module.
        if (file.parsed.calls.length === 0 && file.parsed.imports.length === 0)
            continue;
        // Suppress well-known config filenames regardless of their call/import counts.
        if (isKnownConfigFile(file.relativePath))
            continue;
        anomalies.push(file.relativePath);
    }
    anomalies.sort();
    return {
        count: anomalies.length,
        files: anomalies,
    };
}
//# sourceMappingURL=parseAnomalyDetection.js.map