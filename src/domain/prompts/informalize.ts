/**
 * Code informalization prompt instructions.
 *
 * @remarks
 * Inspired by ClaimCheck's INFORMALIZE_PROMPT: the model reads source code
 * blindly (without seeing original requirements) and produces a faithful
 * natural-language description of what the code actually does.
 *
 * The model is given a structured source context (file listing + selected
 * content) and asked to identify capabilities and describe their behavioral
 * contracts in EARS-preferring format.
 *
 * CRITICAL: The prompt must NOT include the original requirements or spec text.
 * The model sees ONLY source code. This enables an honest round-trip check
 * downstream (blind-compare).
 */

/**
 * Instructions for informalization of source code into behavioral specs.
 *
 * The model receives source file contents grouped by directory/capability and
 * produces EARS-style behavioral requirements for each identified capability.
 */
export const INFORMALIZE_INSTRUCTIONS = `\
You are a software analyst reading source code to describe what it does in \
natural language. You have NOT seen any specification or requirements document. \
Your job is to produce a faithful behavioral description of the code.

## Task

Given the source code below, identify the distinct capabilities the code \
implements and describe each one as a set of behavioral requirements using \
EARS (Easy Approach to Requirements Syntax) patterns.

## EARS patterns to use

- **Event-driven**: WHEN <trigger>, THE system SHALL <response>
- **State-driven**: WHILE <state>, THE system SHALL <response>
- **Complex**: WHILE <state>, WHEN <trigger>, THE system SHALL <response>
- **Conditional**: IF <condition>, THEN THE system SHALL <response>
- **Unwanted-behavior**: IF <failure>, THEN THE system SHALL <response>
- **Optional**: WHERE <feature is included>, THE system SHALL <response>
- **Ubiquitous**: THE system SHALL <response>

## Output format

Return a JSON object:

\`\`\`json
{
  "capabilities": [
    {
      "name": "<kebab-case capability identifier>",
      "description": "<one-sentence summary of what this capability does>",
      "requirements": [
        {
          "id": "<CAPABILITY-NAME-NNN format>",
          "text": "<EARS-formatted requirement text>",
          "evidence": ["<file paths that implement this behavior>"]
        }
      ]
    }
  ]
}
\`\`\`

## Guidelines

- Be LITERAL. Describe what the code actually does, not what you think it \
should do or what a specification might say.
- Each requirement should be verifiable against the source code.
- Focus on externally observable behavior (inputs, outputs, state transitions, \
error handling) rather than internal implementation details.
- Group related behaviors into coherent capabilities.
- Use the file paths and function names as evidence for each requirement.
- Do not guess at unstated behaviors. Only describe what the code explicitly \
implements.
- Strength assessment: rate each requirement as "trivial" (getter/setter), \
"moderate" (business logic), or "strong" (critical invariant/safety property).
- Return ONLY the JSON object. No explanation or commentary.`;

/**
 * Build a prompt section listing known capability names as suggestions for the LLM.
 *
 * The LLM should prefer these names when the code it is analyzing maps to an
 * existing capability, but may still create novel names for genuinely new
 * functionality not covered by the suggestions.
 *
 * @param names - known capability names derived from catalog paths
 * @returns formatted prompt section, or empty string if no names are provided
 *
 * @remarks
 * Precondition: each entry in `names` is a non-empty kebab-case string.
 * Postcondition: the returned section contains ONLY capability names — no
 * requirement text, identifiers, or spec content (preserving the blind boundary).
 */
export function buildCapabilitySuggestionsSection(names: readonly string[]): string {
  if (names.length === 0) return "";

  const listing = names.map((name) => `- ${name}`).join("\n");

  return [
    "## Known capability names (prefer these when applicable)",
    "",
    "The following capability names already exist in this project's specification",
    "structure. When the code you are analyzing clearly maps to one of these",
    "capabilities, USE THAT EXACT NAME as the capability name in your output.",
    "You may still create new capability names for functionality not covered by",
    "this list.",
    "",
    listing,
  ].join("\n");
}

/**
 * Build the source context section for the informalization prompt.
 *
 * @param sourceContext - structured representation of source files
 * @returns fenced source context suitable for appending to INFORMALIZE_INSTRUCTIONS
 */
export function buildSourceContextSection(sourceContext: {
  readonly fileList: readonly string[];
  readonly fileContents: readonly { readonly path: string; readonly content: string }[];
}): string {
  const sections: string[] = [];

  sections.push("## Source directory structure\n");
  sections.push("```");
  sections.push(sourceContext.fileList.join("\n"));
  sections.push("```\n");

  for (const file of sourceContext.fileContents) {
    sections.push(`## File: ${file.path}\n`);
    sections.push("```");
    sections.push(file.content);
    sections.push("```\n");
  }

  return sections.join("\n");
}
