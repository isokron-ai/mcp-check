# mcp-check benchmark score

91 cases with trusted labels, plus 5 faulty-oracle cases (labels deliberately wrong, scored apart). Intervals are Wilson 95%.

## Per check: measured against hand-written labels

Every positive of these checks comes from a case whose labels were written by hand from its source (some also have positives from inferred cases).

| Check | TP | FP | FN | TN | Precision | Recall |
|---|---:|---:|---:|---:|---|---|
| `abstain` | 5 | 3 | 0 | 83 | 62.5% [30.6–86.3] | 100.0% [56.5–100.0] |
| `annot-delete-marked-safe` | 3 | 0 | 0 | 239 | 100.0% [43.9–100.0] | 100.0% [43.9–100.0] |
| `annot-write-marked-readonly` | 3 | 0 | 0 | 239 | 100.0% [43.9–100.0] | 100.0% [43.9–100.0] |
| `openai-name-unique` | 2 | 0 | 0 | 83 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `outcome` | 83 | 0 | 8 | 0 | 100.0% [95.6–100.0] | 91.2% [83.6–95.5] |
| `reader-annotations` | 127 | 0 | 0 | 0 | 100.0% [97.1–100.0] | 100.0% [97.1–100.0] |
| `reader-conditional` | 3 | 0 | 0 | 0 | 100.0% [43.9–100.0] | 100.0% [43.9–100.0] |
| `reader-description` | 127 | 0 | 0 | 0 | 100.0% [97.1–100.0] | 100.0% [97.1–100.0] |
| `reader-params` | 127 | 0 | 0 | 0 | 100.0% [97.1–100.0] | 100.0% [97.1–100.0] |
| `reader-required` | 127 | 0 | 0 | 0 | 100.0% [97.1–100.0] | 100.0% [97.1–100.0] |
| `reader-tools` | 225 | 0 | 14 | 0 | 100.0% [98.3–100.0] | 94.1% [90.4–96.5] |
| `sec-bidi-controls` | 7 | 0 | 0 | 235 | 100.0% [64.6–100.0] | 100.0% [64.6–100.0] |
| `sec-control-chars` | 13 | 0 | 0 | 229 | 100.0% [77.2–100.0] | 100.0% [77.2–100.0] |
| `sec-cross-tool-steering` | 3 | 0 | 0 | 239 | 100.0% [43.9–100.0] | 100.0% [43.9–100.0] |
| `sec-encoded-blob` | 6 | 0 | 0 | 236 | 100.0% [61.0–100.0] | 100.0% [61.0–100.0] |
| `sec-external-instructions` | 6 | 0 | 0 | 236 | 100.0% [61.0–100.0] | 100.0% [61.0–100.0] |
| `sec-homoglyph` | 8 | 0 | 0 | 234 | 100.0% [67.6–100.0] | 100.0% [67.6–100.0] |
| `sec-html-comment` | 6 | 0 | 0 | 236 | 100.0% [61.0–100.0] | 100.0% [61.0–100.0] |
| `sec-instruction-markup` | 3 | 0 | 0 | 239 | 100.0% [43.9–100.0] | 100.0% [43.9–100.0] |
| `sec-instruction-phrases` | 7 | 0 | 0 | 235 | 100.0% [64.6–100.0] | 100.0% [64.6–100.0] |
| `sec-invisible-encoding` | 5 | 0 | 0 | 237 | 100.0% [56.5–100.0] | 100.0% [56.5–100.0] |
| `sec-secret-seeking` | 7 | 0 | 0 | 235 | 100.0% [64.6–100.0] | 100.0% [64.6–100.0] |
| `sec-shell-url` | 9 | 0 | 0 | 233 | 100.0% [70.1–100.0] | 100.0% [70.1–100.0] |
| `sec-zero-width` | 6 | 0 | 0 | 236 | 100.0% [61.0–100.0] | 100.0% [61.0–100.0] |
| `security-cap` | 21 | 0 | 0 | 57 | 100.0% [84.5–100.0] | 100.0% [84.5–100.0] |
| `severity` | 245 | 0 | 0 | 0 | 100.0% [98.5–100.0] | 100.0% [98.5–100.0] |
| `spec-input-schema-field-name` | 2 | 0 | 0 | 5 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `spec-input-schema-missing` | 1 | 0 | 0 | 1 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `spec-name-charset` | 4 | 0 | 0 | 238 | 100.0% [51.0–100.0] | 100.0% [51.0–100.0] |
| `spec-name-length` | 2 | 0 | 0 | 240 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `spec-name-unique` | 2 | 0 | 0 | 83 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |

## Per check: inferred labels, self-consistency only

Every positive of these checks comes from a `truth_level: inferred` case, whose labels were drafted from the engine's own output and then checked by hand. They show that a later build still agrees with this one, not that the check is right.

| Check | TP | FP | FN | TN | Precision | Recall |
|---|---:|---:|---:|---:|---|---|
| `anthropic-conversation-data` | 1 | 0 | 0 | 6 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `anthropic-description` | 7 | 0 | 0 | 3 | 100.0% [64.6–100.0] | 100.0% [64.6–100.0] |
| `anthropic-hint` | 6 | 0 | 0 | 2 | 100.0% [61.0–100.0] | 100.0% [61.0–100.0] |
| `anthropic-hint-platforms-differ` | 3 | 0 | 0 | 6 | 100.0% [43.9–100.0] | 100.0% [43.9–100.0] |
| `anthropic-title` | 14 | 0 | 0 | 0 | 100.0% [78.5–100.0] | 100.0% [78.5–100.0] |
| `anthropic-unsupported-use` | 1 | 0 | 0 | 6 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `design-use-when` | 34 | 0 | 0 | 2 | 100.0% [89.8–100.0] | 100.0% [89.8–100.0] |
| `openai-conversation-input` | 1 | 0 | 0 | 6 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `openai-generic-executor` | 1 | 0 | 0 | 6 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `openai-hints-explicit` | 14 | 0 | 0 | 8 | 100.0% [78.5–100.0] | 100.0% [78.5–100.0] |
| `openai-name-promotional` | 1 | 0 | 0 | 1 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `openai-precise-location` | 1 | 0 | 0 | 6 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `openai-readonly-destructive` | 3 | 0 | 0 | 6 | 100.0% [43.9–100.0] | 100.0% [43.9–100.0] |
| `openai-restricted-input` | 1 | 0 | 0 | 6 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `openai-retry` | 9 | 0 | 0 | 14 | 100.0% [70.1–100.0] | 100.0% [70.1–100.0] |
| `reader-unreadable` | 3 | 0 | 0 | 0 | 100.0% [43.9–100.0] | 100.0% [43.9–100.0] |
| `schema-additional-properties` | 2 | 0 | 0 | 3 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `schema-enum-missing` | 1 | 0 | 0 | 4 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `schema-open-object` | 1 | 0 | 0 | 1 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `schema-output-schema` | 13 | 0 | 0 | 7 | 100.0% [77.2–100.0] | 100.0% [77.2–100.0] |
| `schema-pagination` | 2 | 0 | 0 | 5 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `schema-param-description` | 5 | 0 | 0 | 6 | 100.0% [56.5–100.0] | 100.0% [56.5–100.0] |
| `schema-required-unknown` | 1 | 0 | 0 | 4 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `schema-response-format` | 2 | 0 | 0 | 5 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `schema-vague-param` | 3 | 0 | 0 | 7 | 100.0% [43.9–100.0] | 100.0% [43.9–100.0] |
| `spec-input-schema-root-object` | 1 | 0 | 0 | 4 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `spec-meta-key` | 1 | 0 | 0 | 1 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `spec-meta-reserved` | 1 | 0 | 0 | 1 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `surface-delete-guard` | 2 | 0 | 0 | 5 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `surface-retry-key` | 3 | 0 | 0 | 12 | 100.0% [43.9–100.0] | 100.0% [43.9–100.0] |
| `surface-version-guard` | 5 | 0 | 0 | 10 | 100.0% [56.5–100.0] | 100.0% [56.5–100.0] |

## Per check: no positive case

Only false positives can be measured for these.

| Check | TP | FP | FN | TN | Precision | Recall |
|---|---:|---:|---:|---:|---|---|

## Per check and language

| Check | Language | TP | FP | FN | Precision | Recall |
|---|---|---:|---:|---:|---|---|
| `abstain` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `abstain` | go | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `abstain` | python | 1 | 2 | 0 | 33.3% [6.2–79.2] | 100.0% [20.6–100.0] |
| `abstain` | rust | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `abstain` | typescript | 1 | 1 | 0 | 50.0% [9.4–90.5] | 100.0% [20.6–100.0] |
| `annot-delete-marked-safe` | go | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `annot-delete-marked-safe` | python | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `annot-delete-marked-safe` | typescript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `annot-write-marked-readonly` | go | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `annot-write-marked-readonly` | python | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `annot-write-marked-readonly` | typescript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `anthropic-conversation-data` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `anthropic-description` | go | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `anthropic-description` | javascript | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `anthropic-description` | python | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `anthropic-description` | rust | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `anthropic-hint` | go | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `anthropic-hint` | python | 3 | 0 | 0 | 100.0% [43.9–100.0] | 100.0% [43.9–100.0] |
| `anthropic-hint` | rust | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `anthropic-hint-platforms-differ` | committed-list | 3 | 0 | 0 | 100.0% [43.9–100.0] | 100.0% [43.9–100.0] |
| `anthropic-title` | go | 4 | 0 | 0 | 100.0% [51.0–100.0] | 100.0% [51.0–100.0] |
| `anthropic-title` | javascript | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `anthropic-title` | python | 4 | 0 | 0 | 100.0% [51.0–100.0] | 100.0% [51.0–100.0] |
| `anthropic-title` | rust | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `anthropic-title` | typescript | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `anthropic-unsupported-use` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `design-use-when` | committed-list | 17 | 0 | 0 | 100.0% [81.6–100.0] | 100.0% [81.6–100.0] |
| `design-use-when` | go | 4 | 0 | 0 | 100.0% [51.0–100.0] | 100.0% [51.0–100.0] |
| `design-use-when` | javascript | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `design-use-when` | python | 4 | 0 | 0 | 100.0% [51.0–100.0] | 100.0% [51.0–100.0] |
| `design-use-when` | rust | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `design-use-when` | typescript | 5 | 0 | 0 | 100.0% [56.5–100.0] | 100.0% [56.5–100.0] |
| `openai-conversation-input` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `openai-generic-executor` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `openai-hints-explicit` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `openai-hints-explicit` | go | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `openai-hints-explicit` | javascript | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `openai-hints-explicit` | python | 4 | 0 | 0 | 100.0% [51.0–100.0] | 100.0% [51.0–100.0] |
| `openai-hints-explicit` | rust | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `openai-hints-explicit` | typescript | 3 | 0 | 0 | 100.0% [43.9–100.0] | 100.0% [43.9–100.0] |
| `openai-name-promotional` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `openai-name-unique` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `openai-name-unique` | typescript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `openai-precise-location` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `openai-readonly-destructive` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `openai-readonly-destructive` | go | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `openai-restricted-input` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `openai-retry` | committed-list | 3 | 0 | 0 | 100.0% [43.9–100.0] | 100.0% [43.9–100.0] |
| `openai-retry` | go | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `openai-retry` | javascript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `openai-retry` | python | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `openai-retry` | rust | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `openai-retry` | typescript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `outcome` | committed-list | 11 | 0 | 0 | 100.0% [74.1–100.0] | 100.0% [74.1–100.0] |
| `outcome` | csharp | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `outcome` | go | 13 | 0 | 0 | 100.0% [77.2–100.0] | 100.0% [77.2–100.0] |
| `outcome` | java | 0 | 0 | 1 | n/a | 0.0% [0.0–79.3] |
| `outcome` | javascript | 5 | 0 | 0 | 100.0% [56.5–100.0] | 100.0% [56.5–100.0] |
| `outcome` | kotlin | 0 | 0 | 1 | n/a | 0.0% [0.0–79.3] |
| `outcome` | php | 0 | 0 | 1 | n/a | 0.0% [0.0–79.3] |
| `outcome` | python | 16 | 0 | 2 | 100.0% [80.6–100.0] | 88.9% [67.2–96.9] |
| `outcome` | ruby | 0 | 0 | 1 | n/a | 0.0% [0.0–79.3] |
| `outcome` | rust | 10 | 0 | 0 | 100.0% [72.3–100.0] | 100.0% [72.3–100.0] |
| `outcome` | swift | 0 | 0 | 1 | n/a | 0.0% [0.0–79.3] |
| `outcome` | typescript | 27 | 0 | 1 | 100.0% [87.5–100.0] | 96.4% [82.3–99.4] |
| `reader-annotations` | committed-list | 4 | 0 | 0 | 100.0% [51.0–100.0] | 100.0% [51.0–100.0] |
| `reader-annotations` | go | 20 | 0 | 0 | 100.0% [83.9–100.0] | 100.0% [83.9–100.0] |
| `reader-annotations` | javascript | 8 | 0 | 0 | 100.0% [67.6–100.0] | 100.0% [67.6–100.0] |
| `reader-annotations` | python | 27 | 0 | 0 | 100.0% [87.5–100.0] | 100.0% [87.5–100.0] |
| `reader-annotations` | rust | 15 | 0 | 0 | 100.0% [79.6–100.0] | 100.0% [79.6–100.0] |
| `reader-annotations` | typescript | 53 | 0 | 0 | 100.0% [93.2–100.0] | 100.0% [93.2–100.0] |
| `reader-conditional` | go | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `reader-conditional` | python | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `reader-conditional` | typescript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `reader-description` | committed-list | 4 | 0 | 0 | 100.0% [51.0–100.0] | 100.0% [51.0–100.0] |
| `reader-description` | go | 20 | 0 | 0 | 100.0% [83.9–100.0] | 100.0% [83.9–100.0] |
| `reader-description` | javascript | 8 | 0 | 0 | 100.0% [67.6–100.0] | 100.0% [67.6–100.0] |
| `reader-description` | python | 27 | 0 | 0 | 100.0% [87.5–100.0] | 100.0% [87.5–100.0] |
| `reader-description` | rust | 15 | 0 | 0 | 100.0% [79.6–100.0] | 100.0% [79.6–100.0] |
| `reader-description` | typescript | 53 | 0 | 0 | 100.0% [93.2–100.0] | 100.0% [93.2–100.0] |
| `reader-params` | committed-list | 4 | 0 | 0 | 100.0% [51.0–100.0] | 100.0% [51.0–100.0] |
| `reader-params` | go | 20 | 0 | 0 | 100.0% [83.9–100.0] | 100.0% [83.9–100.0] |
| `reader-params` | javascript | 8 | 0 | 0 | 100.0% [67.6–100.0] | 100.0% [67.6–100.0] |
| `reader-params` | python | 27 | 0 | 0 | 100.0% [87.5–100.0] | 100.0% [87.5–100.0] |
| `reader-params` | rust | 15 | 0 | 0 | 100.0% [79.6–100.0] | 100.0% [79.6–100.0] |
| `reader-params` | typescript | 53 | 0 | 0 | 100.0% [93.2–100.0] | 100.0% [93.2–100.0] |
| `reader-required` | committed-list | 4 | 0 | 0 | 100.0% [51.0–100.0] | 100.0% [51.0–100.0] |
| `reader-required` | go | 20 | 0 | 0 | 100.0% [83.9–100.0] | 100.0% [83.9–100.0] |
| `reader-required` | javascript | 8 | 0 | 0 | 100.0% [67.6–100.0] | 100.0% [67.6–100.0] |
| `reader-required` | python | 27 | 0 | 0 | 100.0% [87.5–100.0] | 100.0% [87.5–100.0] |
| `reader-required` | rust | 15 | 0 | 0 | 100.0% [79.6–100.0] | 100.0% [79.6–100.0] |
| `reader-required` | typescript | 53 | 0 | 0 | 100.0% [93.2–100.0] | 100.0% [93.2–100.0] |
| `reader-tools` | committed-list | 44 | 0 | 0 | 100.0% [92.0–100.0] | 100.0% [92.0–100.0] |
| `reader-tools` | csharp | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `reader-tools` | go | 35 | 0 | 0 | 100.0% [90.1–100.0] | 100.0% [90.1–100.0] |
| `reader-tools` | java | 0 | 0 | 2 | n/a | 0.0% [0.0–65.8] |
| `reader-tools` | javascript | 18 | 0 | 0 | 100.0% [82.4–100.0] | 100.0% [82.4–100.0] |
| `reader-tools` | kotlin | 0 | 0 | 2 | n/a | 0.0% [0.0–65.8] |
| `reader-tools` | php | 0 | 0 | 2 | n/a | 0.0% [0.0–65.8] |
| `reader-tools` | python | 42 | 0 | 4 | 100.0% [91.6–100.0] | 91.3% [79.7–96.6] |
| `reader-tools` | ruby | 0 | 0 | 2 | n/a | 0.0% [0.0–65.8] |
| `reader-tools` | rust | 24 | 0 | 0 | 100.0% [86.2–100.0] | 100.0% [86.2–100.0] |
| `reader-tools` | swift | 0 | 0 | 2 | n/a | 0.0% [0.0–65.8] |
| `reader-tools` | typescript | 60 | 0 | 0 | 100.0% [94.0–100.0] | 100.0% [94.0–100.0] |
| `reader-unreadable` | typescript | 3 | 0 | 0 | 100.0% [43.9–100.0] | 100.0% [43.9–100.0] |
| `schema-additional-properties` | committed-list | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `schema-enum-missing` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `schema-open-object` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `schema-output-schema` | committed-list | 4 | 0 | 0 | 100.0% [51.0–100.0] | 100.0% [51.0–100.0] |
| `schema-output-schema` | go | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `schema-output-schema` | javascript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `schema-output-schema` | python | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `schema-output-schema` | rust | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `schema-output-schema` | typescript | 4 | 0 | 0 | 100.0% [51.0–100.0] | 100.0% [51.0–100.0] |
| `schema-pagination` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `schema-pagination` | javascript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `schema-param-description` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `schema-param-description` | python | 3 | 0 | 0 | 100.0% [43.9–100.0] | 100.0% [43.9–100.0] |
| `schema-param-description` | typescript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `schema-required-unknown` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `schema-response-format` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `schema-response-format` | python | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `schema-vague-param` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `schema-vague-param` | javascript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `schema-vague-param` | typescript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-bidi-controls` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-bidi-controls` | go | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-bidi-controls` | javascript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-bidi-controls` | python | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `sec-bidi-controls` | rust | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-bidi-controls` | typescript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-control-chars` | committed-list | 3 | 0 | 0 | 100.0% [43.9–100.0] | 100.0% [43.9–100.0] |
| `sec-control-chars` | go | 3 | 0 | 0 | 100.0% [43.9–100.0] | 100.0% [43.9–100.0] |
| `sec-control-chars` | javascript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-control-chars` | python | 3 | 0 | 0 | 100.0% [43.9–100.0] | 100.0% [43.9–100.0] |
| `sec-control-chars` | rust | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-control-chars` | typescript | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `sec-cross-tool-steering` | go | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-cross-tool-steering` | javascript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-cross-tool-steering` | typescript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-encoded-blob` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-encoded-blob` | go | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-encoded-blob` | javascript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-encoded-blob` | python | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-encoded-blob` | rust | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-encoded-blob` | typescript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-external-instructions` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-external-instructions` | go | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-external-instructions` | javascript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-external-instructions` | python | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-external-instructions` | rust | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-external-instructions` | typescript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-homoglyph` | committed-list | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `sec-homoglyph` | go | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `sec-homoglyph` | javascript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-homoglyph` | python | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `sec-homoglyph` | rust | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-html-comment` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-html-comment` | go | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-html-comment` | javascript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-html-comment` | python | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-html-comment` | rust | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-html-comment` | typescript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-instruction-markup` | python | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-instruction-markup` | rust | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-instruction-markup` | typescript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-instruction-phrases` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-instruction-phrases` | go | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-instruction-phrases` | python | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `sec-instruction-phrases` | rust | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `sec-instruction-phrases` | typescript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-invisible-encoding` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-invisible-encoding` | go | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-invisible-encoding` | javascript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-invisible-encoding` | python | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-invisible-encoding` | rust | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-secret-seeking` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-secret-seeking` | go | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-secret-seeking` | javascript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-secret-seeking` | python | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `sec-secret-seeking` | rust | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-secret-seeking` | typescript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-shell-url` | committed-list | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `sec-shell-url` | go | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `sec-shell-url` | python | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `sec-shell-url` | typescript | 3 | 0 | 0 | 100.0% [43.9–100.0] | 100.0% [43.9–100.0] |
| `sec-zero-width` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-zero-width` | go | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-zero-width` | javascript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-zero-width` | python | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-zero-width` | rust | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `sec-zero-width` | typescript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `security-cap` | committed-list | 3 | 0 | 0 | 100.0% [43.9–100.0] | 100.0% [43.9–100.0] |
| `security-cap` | go | 3 | 0 | 0 | 100.0% [43.9–100.0] | 100.0% [43.9–100.0] |
| `security-cap` | javascript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `security-cap` | python | 5 | 0 | 0 | 100.0% [56.5–100.0] | 100.0% [56.5–100.0] |
| `security-cap` | rust | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `security-cap` | typescript | 7 | 0 | 0 | 100.0% [64.6–100.0] | 100.0% [64.6–100.0] |
| `severity` | committed-list | 76 | 0 | 0 | 100.0% [95.2–100.0] | 100.0% [95.2–100.0] |
| `severity` | go | 39 | 0 | 0 | 100.0% [91.0–100.0] | 100.0% [91.0–100.0] |
| `severity` | javascript | 25 | 0 | 0 | 100.0% [86.7–100.0] | 100.0% [86.7–100.0] |
| `severity` | python | 45 | 0 | 0 | 100.0% [92.1–100.0] | 100.0% [92.1–100.0] |
| `severity` | rust | 22 | 0 | 0 | 100.0% [85.1–100.0] | 100.0% [85.1–100.0] |
| `severity` | typescript | 38 | 0 | 0 | 100.0% [90.8–100.0] | 100.0% [90.8–100.0] |
| `spec-input-schema-field-name` | committed-list | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `spec-input-schema-missing` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `spec-input-schema-root-object` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `spec-meta-key` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `spec-meta-reserved` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `spec-name-charset` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `spec-name-charset` | go | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `spec-name-charset` | python | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `spec-name-charset` | typescript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `spec-name-length` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `spec-name-length` | javascript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `spec-name-unique` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `spec-name-unique` | typescript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `surface-delete-guard` | committed-list | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `surface-delete-guard` | javascript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `surface-retry-key` | committed-list | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| `surface-retry-key` | typescript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `surface-version-guard` | committed-list | 3 | 0 | 0 | 100.0% [43.9–100.0] | 100.0% [43.9–100.0] |
| `surface-version-guard` | javascript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| `surface-version-guard` | typescript | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |

Rows with no positive and no finding in a language are left out of this table; the JSON has every cell.

## Per language: what the reader decided

| Language | Cases | Outcome right | Abstained (observed) | Abstain expected | Unsupported or none (observed) | Unsupported expected |
|---|---:|---|---|---:|---|---:|
| committed-list | 11 | 100.0% [74.1–100.0] | 9.1% [1.6–37.7] | 1 | 0.0% [0.0–25.9] | 0 |
| csharp | 1 | 100.0% [20.6–100.0] | 0.0% [0.0–79.3] | 0 | 0.0% [0.0–79.3] | 0 |
| go | 13 | 100.0% [77.2–100.0] | 7.7% [1.4–33.3] | 1 | 0.0% [0.0–22.8] | 0 |
| java | 1 | 0.0% [0.0–79.3] | 0.0% [0.0–79.3] | 0 | 100.0% [20.6–100.0] | 0 |
| javascript | 5 | 100.0% [56.5–100.0] | 0.0% [0.0–43.5] | 0 | 0.0% [0.0–43.5] | 0 |
| kotlin | 1 | 0.0% [0.0–79.3] | 0.0% [0.0–79.3] | 0 | 100.0% [20.6–100.0] | 0 |
| php | 1 | 0.0% [0.0–79.3] | 0.0% [0.0–79.3] | 0 | 100.0% [20.6–100.0] | 0 |
| python | 18 | 88.9% [67.2–96.9] | 16.7% [5.8–39.2] | 1 | 0.0% [0.0–17.6] | 0 |
| ruby | 1 | 0.0% [0.0–79.3] | 0.0% [0.0–79.3] | 0 | 100.0% [20.6–100.0] | 0 |
| rust | 10 | 100.0% [72.3–100.0] | 10.0% [1.8–40.4] | 1 | 0.0% [0.0–27.8] | 0 |
| swift | 1 | 0.0% [0.0–79.3] | 0.0% [0.0–79.3] | 0 | 100.0% [20.6–100.0] | 0 |
| typescript | 28 | 96.4% [82.3–99.4] | 7.1% [2.0–22.7] | 1 | 0.0% [0.0–12.1] | 1 |

## Tool reading per idiom

| Idiom | TP | FP | FN | Precision | Recall |
|---|---:|---:|---:|---|---|
| adversarial | 109 | 0 | 0 | 100.0% [96.6–100.0] | 100.0% [96.6–100.0] |
| aliasing | 4 | 0 | 0 | 100.0% [51.0–100.0] | 100.0% [51.0–100.0] |
| conditional | 7 | 0 | 0 | 100.0% [64.6–100.0] | 100.0% [64.6–100.0] |
| decorator | 22 | 0 | 4 | 100.0% [85.1–100.0] | 84.6% [66.5–93.8] |
| dynamic | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| explicit-registration | 2 | 0 | 4 | 100.0% [34.2–100.0] | 33.3% [9.7–70.0] |
| generated | 8 | 0 | 2 | 100.0% [67.6–100.0] | 80.0% [49.0–94.3] |
| imported | 8 | 0 | 0 | 100.0% [67.6–100.0] | 100.0% [67.6–100.0] |
| indirection | 22 | 0 | 0 | 100.0% [85.1–100.0] | 100.0% [85.1–100.0] |
| low-level | 9 | 0 | 2 | 100.0% [70.1–100.0] | 81.8% [52.3–94.9] |
| macro | 13 | 0 | 0 | 100.0% [77.2–100.0] | 100.0% [77.2–100.0] |
| misleading-names | 12 | 0 | 0 | 100.0% [75.8–100.0] | 100.0% [75.8–100.0] |
| monorepo | 1 | 0 | 0 | 100.0% [20.6–100.0] | 100.0% [20.6–100.0] |
| partial-invalid | 14 | 0 | 0 | 100.0% [78.5–100.0] | 100.0% [78.5–100.0] |
| split-modules | 2 | 0 | 0 | 100.0% [34.2–100.0] | 100.0% [34.2–100.0] |
| straight-line | 40 | 0 | 0 | 100.0% [91.2–100.0] | 100.0% [91.2–100.0] |
| wrapper | 8 | 0 | 4 | 100.0% [67.6–100.0] | 66.7% [39.1–86.2] |

## Faulty-oracle cases

Each of these has a label that is wrong on purpose. The scorer must disagree with it; a case marked NOT CAUGHT means the scorer echoed the label.

| Case | Caught | Why the label is wrong | Disagreement required | What the scorer said |
|---|---|---|---|---|
| faulty-oracle/extra-tool-label | yes | the list has only lookup_word; the label adds random_word | `reader-tools\|fn\|random_word` | missed tool random_word |
| faulty-oracle/missed-poison-label | yes | summarise says "Ignore all previous instructions"; the label claims no tool has the phrase | `sec-instruction-phrases\|fp\|summarise` | sec-instruction-phrases raised on summarise (truth: not this check); grades capped at F with no blocking security finding labelled (security F, anthropic F, openai F) |
| faulty-oracle/phantom-finding-label | yes | no description has an HTML comment; the label claims get_value has one | `sec-html-comment\|fn\|get_value` | sec-html-comment missed on get_value |
| faulty-oracle/wrong-outcome | yes | there is only one server; the label claims several | `outcome\|fn\|multiple->tools` | outcome: expected multiple, got tools; phantom tool single_status |
| faulty-oracle/wrong-tool-name | yes | the first tool is list_labels; the label drops the s | `reader-tools\|fn\|list_label` | missed tool list_label; phantom tool list_labels |

## Known gaps

- **real-world/cve-2025-6514-shape** (CVE-2025-6514 (mcp-remote OS command injection via a crafted authorization_endpoint), static shape only): mcp-check grades the tools/list only. The vulnerable value in CVE-2025-6514 is the OAuth authorization_endpoint the server advertises, which is not part of any tool, so no check can see it statically. The same shell syntax placed in a tool description is the part mcp-check could see; sec-shell-url (loop upgrade 19) now flags a URL with shell command substitution ($(...) or a backtick, "&&", a newline then a command) in the description, so the part mcp-check can see is covered. The authorization_endpoint itself stays out of reach of a tools/list grade. Every label of this case agrees today.

## Every disagreement

- **java/spring-tool-methods**: outcome: expected tools, got none (mcp-check: no tool definitions found in <case> (scanned 0 of 0 source files, and the committed tool lists and MCPB manifests). Grade the live list instead: star); missed tool city_temperature; missed tool city_humidity
- **kotlin/sdk-add-tool**: outcome: expected tools, got unsupported (mcp-check: no tool definitions found in <case> (scanned 0 of 0 source files, and the committed tool lists and MCPB manifests). Grade the live list instead: star); missed tool roll_die; missed tool flip_coin
- **php/attribute-tools**: outcome: expected tools, got unsupported (mcp-check: no tool definitions found in <case> (scanned 0 of 0 source files, and the committed tool lists and MCPB manifests). Grade the live list instead: star); missed tool add_integers; missed tool subtract_integers
- **python/class-methods**: outcome: expected tools, got incomplete (mcp-check: reading <case>: 2 possible tool definitions in server.py could not be read completely (registration not seen: an MCP server is built here and registe); abstained (incomplete) on a case with a list to grade; missed tool distance_km; missed tool bearing_deg
- **python/generated-loop**: outcome: expected tools, got incomplete (mcp-check: reading <case>: 1 possible tool definition in server.py could not be read completely (registration not seen: an MCP server is built here and register); abstained (incomplete) on a case with a list to grade; missed tool to_celsius; missed tool to_fahrenheit
- **ruby/tool-classes**: outcome: expected tools, got unsupported (mcp-check: no tool definitions found in <case> (scanned 0 of 0 source files, and the committed tool lists and MCPB manifests). Grade the live list instead: star); missed tool ping_host; missed tool host_uptime
- **swift/sdk-tools**: outcome: expected tools, got unsupported (mcp-check: no tool definitions found in <case> (scanned 0 of 0 source files, and the committed tool lists and MCPB manifests). Grade the live list instead: star); missed tool utc_now; missed tool unix_time
- **typescript/dynamic-remote-list**: outcome: expected none, got incomplete (mcp-check: reading <case>: 1 possible tool definition in src/index.ts could not be read completely (registration not seen: an MCP server is built here and regis); abstained (incomplete) on a case with a list to grade
