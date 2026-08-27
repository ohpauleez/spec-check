#!/usr/bin/env bash

set -euo pipefail

COPROC_SCOPE="file"
VERBOSE=0
DEBUG=0
ALLOY_MODE=""
EVIDENCE_WARNING_COUNT=0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPOSITORY_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"

CURRENT_LANG=""
CURRENT_FILE=""
COPROC_RUNNING=0
COPROC_OUT_FD=""
COPROC_IN_FD=""
COPROC_PID_VALUE=""
LAST_OUTPUT_LINES=()
LAST_FILE_HAS_ALLOY=0
FILES_WITH_ALLOY=()

usage() {
  printf 'Usage:\n'
  printf '  %s [--verbose] [--debug] [--scope block|file] [--alloy <alloy-binary>|<alloy-jar>] <markdown-file> [markdown-file ...]\n' "$0"
  printf '\n'
  printf 'Arguments:\n'
  printf '  <markdown-file>         One or more markdown files to evaluate.\n'
  printf '                          Files are processed in the order provided.\n'
  printf '\n'
  printf 'Options:\n'
  printf '  --scope <block|file>    Evaluator reuse mode.\n'
  printf '                          block: one evaluator per code block.\n'
  printf '                          file: one evaluator reused per markdown file.\n'
  printf '  --verbose               Print parser progress (ENTER/FOUND/BEGIN/END).\n'
  printf '  --debug                 Print normalized and raw evaluator output for checks.\n'
  printf '  --alloy <path>          Run Alloy at the end for files containing alloy blocks.\n'
  printf '                          If path ends with .jar: java -jar <path> exec -f <file>\n'
  printf '                          Otherwise:             <path> exec -f <file>\n'
  printf '                          Java evaluator startup rules:\n'
  printf '                          - If Makefile has jshell target: use make jshell (required).\n'
  printf '                          - If no Makefile or no jshell target: fallback to jshell on PATH.\n'
  printf '                          - If required make jshell fails: exit 1 (no fallback).\n'
  printf '  -h, --help              Show this help and exit.\n'
  printf '\n'
  printf 'Defaults:\n'
  printf '  --scope file\n'
  printf '  --verbose off\n'
  printf '  --debug off\n'
  printf '  --alloy disabled (unless --alloy is provided)\n'
  printf '  Supported Evidence evaluator languages: java, javascript, typescript, js, ts\n'
  printf '  Unsupported Evidence example languages are skipped.\n'
  printf '\n'
  printf 'Evidence links:\n'
  printf '  Implementation and Test links are checked against repository files.\n'
  printf '  Label filenames and lines must match link targets. Named symbols and\n'
  printf '  test descriptions must occur on the exact target line. Mismatches warn.\n'
  printf '\n'
  printf 'Expectation comments:\n'
  printf '  Inside Evidence example code blocks, trailing comments define expectations:\n'
  printf '  //=> <value>            Expect output/value to match\n'
  printf '  //=> type <TypeName>    Expect variable type to match\n'
  printf '                          For js/ts, type is checked with var.constructor.name\n'
  printf '  //=> throws <Exception> Expect an exception to be thrown\n'
  printf '  //*                     Expect any non-exception output\n'
  printf '\n'
  printf 'Example evidence blocks:\n'
  printf '  ```javascript\n'
  printf '  let x = 5; //=> 5\n'
  printf '  x = 6; //=> type Number\n'
  printf '  x + 1; //*\n'
  printf '  JSON.parse("{"); //=> throws SyntaxError\n'
  printf '  ```\n'
  printf '\n'
  printf '  ```java\n'
  printf '  var n = 1 + 1; //=> 2\n'
  printf '  var name = "demo"; //=> type String\n'
  printf '  name.length(); //*\n'
  printf '  Integer.parseInt("bad"); //=> throws NumberFormatException\n'
  printf '  ```\n'
  printf '\n'
  printf 'Examples:\n'
  printf '  %s spec.md\n' "$0"
  printf '  %s --verbose spec.md\n' "$0"
  printf '  %s --scope block spec.md another-spec.md\n' "$0"
  printf '  %s --debug design.md\n' "$0"
  printf '  %s --alloy tooling/alloy-6.2.0/bin/alloy spec.md\n' "$0"
  printf '  %s --alloy tooling/alloy-6.2.0/lib/app/org.alloytools.alloy.dist.jar spec.md\n' "$0"
}

verbose_log() {
  if [[ "$VERBOSE" == "1" ]]; then
    printf '%s\n' "$1"
  fi
}

debug_log() {
  if [[ "$DEBUG" == "1" ]]; then
    printf '%s\n' "$1"
  fi
}

trim() {
  local value="$1"
  value="${value#${value%%[![:space:]]*}}"
  value="${value%${value##*[![:space:]]}}"
  printf '%s' "$value"
}

warn_evidence_link() {
  local markdown_file="$1"
  local source_line="$2"
  local evidence_type="$3"
  local target="$4"
  local expected="$5"
  local actual="$6"

  EVIDENCE_WARNING_COUNT=$((EVIDENCE_WARNING_COUNT + 1))
  printf 'WARNING: Evidence link does not match target\n' >&2
  printf 'Spec: %s:%s\n' "$markdown_file" "$source_line" >&2
  printf 'Type: %s\n' "$evidence_type" >&2
  printf 'Target: %s\n' "$target" >&2
  printf 'Expected: %s\n' "$expected" >&2
  printf 'Actual: %s\n' "$actual" >&2
}

TARGET_LINE=""
TARGET_LINE_FOUND=0

read_target_line() {
  local target_file="$1"
  local target_line_no="$2"
  local current_line=""
  local current_line_no=0

  TARGET_LINE=""
  TARGET_LINE_FOUND=0
  while IFS= read -r current_line || [[ -n "$current_line" ]]; do
    current_line_no=$((current_line_no + 1))
    if [[ "$current_line_no" == "$target_line_no" ]]; then
      TARGET_LINE="$current_line"
      TARGET_LINE_FOUND=1
      return
    fi
  done < "$target_file"
  return 0
}

validate_evidence_link() {
  local markdown_file="$1"
  local source_line="$2"
  local evidence_type="$3"
  local label="$4"
  local url="$5"
  local label_file=""
  local label_line=""
  local description=""
  local url_path=""
  local url_line=""

  if [[ "$label" =~ ^([^:[:space:]]+):([0-9]+)[[:space:]]+(.+)$ ]]; then
    label_file="${BASH_REMATCH[1]}"
    label_line="${BASH_REMATCH[2]}"
    description="${BASH_REMATCH[3]}"
  else
    warn_evidence_link "$markdown_file" "$source_line" "$evidence_type" "$url" \
      '<File>:<Line> <method/function or test description>' "$label"
    return
  fi

  if [[ "$url" =~ ^(/[^#]+)#L([0-9]+)$ ]]; then
    url_path="${BASH_REMATCH[1]}"
    url_line="${BASH_REMATCH[2]}"
  else
    warn_evidence_link "$markdown_file" "$source_line" "$evidence_type" "$url" \
      '/<relative-path>#L<line>' "$url"
    return
  fi

  local target_name="${url_path##*/}"
  if [[ "$label_file" != "$target_name" ]]; then
    warn_evidence_link "$markdown_file" "$source_line" "$evidence_type" "$url" \
      "filename $target_name" "filename $label_file"
  fi
  if [[ "$label_line" != "$url_line" ]]; then
    warn_evidence_link "$markdown_file" "$source_line" "$evidence_type" "$url" \
      "line $url_line" "line $label_line"
  fi
  if [[ "$url_line" == "0" || "$url_path" =~ (^|/)\.\.(/|$) ]]; then
    warn_evidence_link "$markdown_file" "$source_line" "$evidence_type" "$url" \
      'a repository-relative file and a positive line number' "$url"
    return
  fi

  local target_file="$REPOSITORY_ROOT/${url_path#/}"
  if [[ ! -f "$target_file" ]]; then
    warn_evidence_link "$markdown_file" "$source_line" "$evidence_type" "$url" \
      'an existing repository file' 'file not found'
    return
  fi

  local target_dir="${target_file%/*}"
  local target_base="${target_file##*/}"
  local resolved_dir=""
  resolved_dir="$(cd "$target_dir" 2>/dev/null && pwd -P)" || true
  local resolved_target="$resolved_dir/$target_base"
  if [[ -z "$resolved_dir" || "$resolved_target" != "$REPOSITORY_ROOT/"* ]]; then
    warn_evidence_link "$markdown_file" "$source_line" "$evidence_type" "$url" \
      'a target inside the repository' "$resolved_target"
    return
  fi

  read_target_line "$resolved_target" "$url_line"
  if [[ "$TARGET_LINE_FOUND" != "1" ]]; then
    warn_evidence_link "$markdown_file" "$source_line" "$evidence_type" "$url" \
      "line $url_line to exist" 'line not found'
    return
  fi

  local expected_text=""
  if [[ "$evidence_type" == "Implementation" ]]; then
    if [[ "$description" =~ ^[[:alpha:]_$][[:alnum:]_$.]*(\(\))?$ ]]; then
      expected_text="${description%\(\)}"
    else
      return 0
    fi
  else
    expected_text="$description"
  fi

  if [[ "$TARGET_LINE" != *"$expected_text"* ]]; then
    warn_evidence_link "$markdown_file" "$source_line" "$evidence_type" "$url" \
      "$expected_text" "$TARGET_LINE"
  fi
}

validate_evidence_links() {
  local markdown_file="$1"
  local source_line="$2"
  local evidence_type="$3"
  local remaining="$4"
  local found_link=0

  while [[ "$remaining" == *"["* ]]; do
    remaining="${remaining#*\[}"
    local depth=1
    local index=0
    local label_end=-1
    while (( index < ${#remaining} )); do
      local character="${remaining:index:1}"
      if [[ "$character" == "[" ]]; then
        depth=$((depth + 1))
      elif [[ "$character" == "]" ]]; then
        depth=$((depth - 1))
        if (( depth == 0 )); then
          label_end=$index
          break
        fi
      fi
      index=$((index + 1))
    done

    if (( label_end < 0 )) || [[ "${remaining:label_end + 1:1}" != "(" ]]; then
      warn_evidence_link "$markdown_file" "$source_line" "$evidence_type" '<unparseable>' \
        'a Markdown link in [label](target) form' "$remaining"
      return
    fi

    local label="${remaining:0:label_end}"
    local after_label="${remaining:label_end + 2}"
    if [[ "$after_label" != *")"* ]]; then
      warn_evidence_link "$markdown_file" "$source_line" "$evidence_type" '<unparseable>' \
        'a Markdown link in [label](target) form' "$after_label"
      return
    fi

    local url="${after_label%%)*}"
    remaining="${after_label#*)}"
    found_link=1
    validate_evidence_link "$markdown_file" "$source_line" "$evidence_type" "$label" "$url"
  done

  if [[ "$found_link" != "1" ]]; then
    warn_evidence_link "$markdown_file" "$source_line" "$evidence_type" '<missing>' \
      'at least one Markdown evidence link' "$4"
  fi
}

cleanup_coproc() {
  if [[ "$COPROC_RUNNING" == "1" ]]; then
    kill "$COPROC_PID_VALUE" 2>/dev/null || true
    wait "$COPROC_PID_VALUE" 2>/dev/null || true
    COPROC_RUNNING=0
    CURRENT_LANG=""
    COPROC_OUT_FD=""
    COPROC_IN_FD=""
    COPROC_PID_VALUE=""
  fi
}

trap cleanup_coproc EXIT

read_until_quiet() {
  LAST_OUTPUT_LINES=()
  local line
  local quiet_reads=0
  while true; do
    if IFS= read -r -t 0.2 -u "$COPROC_OUT_FD" line 2>/dev/null; then
      LAST_OUTPUT_LINES+=("$line")
      quiet_reads=0
    else
      quiet_reads=$((quiet_reads + 1))
      if (( quiet_reads >= 3 )); then
        break
      fi
    fi
  done
}

start_coproc() {
  local lang="$1"
  if is_java_language "$lang"; then
    if has_makefile && makefile_has_jshell_target; then
      if start_java_coproc_make; then
        return 0
      fi
      printf "Failed to start Java evaluator via 'make jshell'\n"
      exit 1
    fi

    if start_java_coproc_system; then
      return 0
    fi

    printf "Failed to start Java evaluator via 'jshell'\n"
    exit 1
  fi

  if is_js_like_language "$lang"; then
    if start_bun_coproc "$lang"; then
      return 0
    fi
    printf "Failed to start JavaScript/TypeScript evaluator via 'bun repl'\n"
    exit 1
  fi

  return 1
}

is_supported_language() {
  local lang="$1"
  is_java_language "$lang" || is_js_like_language "$lang"
}

is_java_language() {
  local lang="$1"
  [[ "$lang" == "java" ]]
}

is_js_like_language() {
  local lang="$1"
  [[ "$lang" == "javascript" || "$lang" == "typescript" || "$lang" == "js" || "$lang" == "ts" ]]
}

has_makefile() {
  [[ -f "Makefile" ]]
}

makefile_has_jshell_target() {
  if [[ ! -f "Makefile" ]]; then
    return 1
  fi

  local line
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" =~ ^[[:space:]]*jshell[[:space:]]*: ]]; then
      return 0
    fi
  done < "Makefile"

  return 1
}

probe_java_repl() {
  if [[ ! "$COPROC_IN_FD" =~ ^[0-9]+$ || ! "$COPROC_OUT_FD" =~ ^[0-9]+$ ]]; then
    return 1
  fi

  if ! kill -0 "$COPROC_PID_VALUE" 2>/dev/null; then
    return 1
  fi

  if ! printf '/vars\n' >&"$COPROC_IN_FD"; then
    return 1
  fi

  read_until_quiet

  if ! kill -0 "$COPROC_PID_VALUE" 2>/dev/null; then
    return 1
  fi

  return 0
}

start_java_coproc_make() {
  cleanup_coproc
  coproc EVIDENCE_COPROC { exec make --no-print-directory jshell 2>&1; }
  COPROC_OUT_FD="${EVIDENCE_COPROC[0]}"
  COPROC_IN_FD="${EVIDENCE_COPROC[1]}"
  COPROC_PID_VALUE="$EVIDENCE_COPROC_PID"
  COPROC_RUNNING=1
  CURRENT_LANG="java"
  read_until_quiet

  if probe_java_repl; then
    debug_log "DEBUG using Java evaluator: make jshell"
    return 0
  fi

  cleanup_coproc
  return 1
}

start_java_coproc_system() {
  cleanup_coproc
  coproc EVIDENCE_COPROC { exec jshell 2>&1; }
  COPROC_OUT_FD="${EVIDENCE_COPROC[0]}"
  COPROC_IN_FD="${EVIDENCE_COPROC[1]}"
  COPROC_PID_VALUE="$EVIDENCE_COPROC_PID"
  COPROC_RUNNING=1
  CURRENT_LANG="java"
  read_until_quiet

  if probe_java_repl; then
    debug_log "DEBUG using Java evaluator: jshell"
    return 0
  fi

  cleanup_coproc
  return 1
}

strip_ansi() {
  local text="$1"
  local esc
  esc=$'\033'
  text="${text//${esc}\[[0-9;]*[[:alpha:]]/}"
  text="${text//$'\r'/}"
  text="${text//$'\b'/}"
  printf '%s' "$text"
}

probe_bun_repl() {
  if [[ ! "$COPROC_IN_FD" =~ ^[0-9]+$ || ! "$COPROC_OUT_FD" =~ ^[0-9]+$ ]]; then
    return 1
  fi

  if ! kill -0 "$COPROC_PID_VALUE" 2>/dev/null; then
    return 1
  fi

  if ! printf '1+1\n' >&"$COPROC_IN_FD"; then
    return 1
  fi

  read_until_quiet

  if ! kill -0 "$COPROC_PID_VALUE" 2>/dev/null; then
    return 1
  fi

  local raw
  raw="$(output_blob)"
  raw="$(strip_ansi "$raw")"
  if [[ "$raw" != *"2"* ]]; then
    return 1
  fi

  return 0
}

start_bun_coproc() {
  local lang="$1"
  cleanup_coproc
  coproc EVIDENCE_COPROC { exec bun repl 2>&1; }
  COPROC_OUT_FD="${EVIDENCE_COPROC[0]}"
  COPROC_IN_FD="${EVIDENCE_COPROC[1]}"
  COPROC_PID_VALUE="$EVIDENCE_COPROC_PID"
  COPROC_RUNNING=1
  CURRENT_LANG="$lang"
  read_until_quiet

  if probe_bun_repl; then
    debug_log "DEBUG using JS/TS evaluator: bun repl"
    return 0
  fi

  cleanup_coproc
  return 1
}

run_alloy_for_file() {
  local markdown_file="$1"
  if [[ -z "$ALLOY_MODE" ]]; then
    return
  fi

  if [[ "$ALLOY_MODE" == *.jar ]]; then
    java -jar "$ALLOY_MODE" exec -f "$markdown_file"
  else
    "$ALLOY_MODE" exec -f "$markdown_file"
  fi
}

run_alloy_phase() {
  if [[ -z "$ALLOY_MODE" ]]; then
    return
  fi

  local markdown_file
  for markdown_file in "${FILES_WITH_ALLOY[@]}"; do
    run_alloy_for_file "$markdown_file"
  done
}

ensure_coproc() {
  local lang="$1"
  if [[ "$COPROC_RUNNING" != "1" ]]; then
    start_coproc "$lang"
    return
  fi
  if [[ "$CURRENT_LANG" != "$lang" ]]; then
    start_coproc "$lang"
  fi
}

send_and_capture() {
  local input_line="$1"
  printf '%s\n' "$input_line" >&"$COPROC_IN_FD"
  read_until_quiet
}

output_blob() {
  if (( ${#LAST_OUTPUT_LINES[@]} == 0 )); then
    return
  fi
  printf '%s\n' "${LAST_OUTPUT_LINES[@]}"
}

fail_mismatch() {
  local markdown_file="$1"
  local source_line="$2"
  local input_line="$3"
  local expected="$4"
  local actual="$5"

  printf 'Evidence check failed\n'
  printf 'File: %s\n' "$markdown_file"
  printf 'Line: %s\n' "$source_line"
  printf 'Input: %s\n' "$input_line"
  printf 'Expected: %s\n' "$expected"
  printf 'Actual: %s\n' "$actual"
  exit 1
}

sanitize_line() {
  local value="$1"
  value="$(strip_ansi "$value")"
  printf '%s' "$(trim "$value")"
}

strip_wrapping_quotes() {
  local value
  value="$(trim "$1")"
  if [[ "$value" == '"'*'"' && ${#value} -ge 2 ]]; then
    value="${value#\"}"
    value="${value%\"}"
  fi
  printf '%s' "$value"
}

NORMALIZED_KIND="unknown"
NORMALIZED_DISPLAY="<no output>"
NORMALIZED_VALUE=""
NORMALIZED_EXCEPTION=""
NORMALIZED_TYPE=""

extract_exception_name() {
  local actual="$1"
  local line
  while IFS= read -r line; do
    line="$(sanitize_line "$line")"
    if [[ "$line" =~ ^\|[[:space:]]+Exception[[:space:]]+([^:]+): ]]; then
      local exception_class
      exception_class="${BASH_REMATCH[1]}"
      printf '%s' "${exception_class##*.}"
      return
    fi
    if [[ "$line" =~ ^([[:alnum:]_$.]+Error): ]]; then
      printf '%s' "${BASH_REMATCH[1]##*.}"
      return
    fi
    # Bun REPL renders base Error as lowercase "error:" while subclasses
    # (TypeError, SyntaxError, …) keep their class name.
    if [[ "$line" =~ ^error:[[:space:]] ]]; then
      printf 'Error'
      return
    fi
  done <<< "$actual"
  printf ''
}

extract_type_for_var() {
  local actual="$1"
  local var_name="$2"
  local var_line
  while IFS= read -r var_line; do
    if [[ "$var_line" =~ ^[[:space:]]*\|?[[:space:]]*(final[[:space:]]+)?([^[:space:]]+)[[:space:]]+${var_name}[[:space:]]*= ]]; then
      printf '%s' "${BASH_REMATCH[2]}"
      return
    fi
  done <<< "$actual"
  printf ''
}

extract_value_output() {
  local actual="$1"
  local line
  local latest_value=""
  while IFS= read -r line; do
    line="$(sanitize_line "$line")"
    if [[ -z "$line" ]]; then
      continue
    fi
    if [[ "$line" == "jshell>"* ]]; then
      continue
    fi
    if [[ "$line" =~ ^\>[[:space:]] ]]; then
      continue
    fi
    if [[ "$line" == "Welcome to Bun "* ]]; then
      continue
    fi
    if [[ "$line" == "Type .copy "* ]]; then
      continue
    fi
    if [[ "$line" =~ ==\>[[:space:]](.+)$ ]]; then
      latest_value="${BASH_REMATCH[1]}"
      continue
    fi
  done <<< "$actual"

  if [[ -n "$latest_value" ]]; then
    printf '%s' "$latest_value"
    return
  fi

  local fallback=""
  while IFS= read -r line; do
    line="$(sanitize_line "$line")"
    if [[ -z "$line" ]]; then
      continue
    fi
    if [[ "$line" == "jshell>"* || "$line" =~ ^\>[[:space:]] ]]; then
      continue
    fi
    if [[ "$line" == "Welcome to Bun "* || "$line" == "Type .copy "* ]]; then
      continue
    fi
    if [[ -n "$line" ]]; then
      fallback="$line"
    fi
  done <<< "$actual"
  printf '%s' "$fallback"
}

normalize_actual_output() {
  local expectation_kind="$1"
  local raw_output="$2"
  local var_name="${3:-}"

  NORMALIZED_KIND="unknown"
  NORMALIZED_DISPLAY="<no output>"
  NORMALIZED_VALUE=""
  NORMALIZED_EXCEPTION=""
  NORMALIZED_TYPE=""

  if [[ "$expectation_kind" == "throws" ]]; then
    NORMALIZED_EXCEPTION="$(extract_exception_name "$raw_output")"
    if [[ -n "$NORMALIZED_EXCEPTION" ]]; then
      NORMALIZED_KIND="throws"
      NORMALIZED_DISPLAY="throws ${NORMALIZED_EXCEPTION##*.}"
      return
    fi

    NORMALIZED_VALUE="$(extract_value_output "$raw_output")"
    if [[ -n "$NORMALIZED_VALUE" ]]; then
      NORMALIZED_KIND="value"
      NORMALIZED_DISPLAY="$NORMALIZED_VALUE"
      return
    fi

    NORMALIZED_KIND="none"
    NORMALIZED_DISPLAY="<no output>"
    return
  fi

  if [[ "$expectation_kind" == "type" ]]; then
    NORMALIZED_TYPE="$(extract_type_for_var "$raw_output" "$var_name")"
    NORMALIZED_KIND="type"
    if [[ -n "$NORMALIZED_TYPE" ]]; then
      NORMALIZED_DISPLAY="type ${NORMALIZED_TYPE##*.}"
    else
      NORMALIZED_DISPLAY="type <unknown>"
    fi
    return
  fi

  NORMALIZED_VALUE="$(extract_value_output "$raw_output")"
  if [[ -n "$NORMALIZED_VALUE" ]]; then
    NORMALIZED_KIND="value"
    NORMALIZED_DISPLAY="$NORMALIZED_VALUE"
  else
    NORMALIZED_KIND="none"
    NORMALIZED_DISPLAY="<no output>"
  fi
}

format_actual_for_display() {
  printf '%s' "$NORMALIZED_DISPLAY"
}

debug_log_normalized() {
  local label="$1"
  local raw_output="$2"
  debug_log "DEBUG ${label} normalized: ${NORMALIZED_DISPLAY}"
  if [[ "$DEBUG" == "1" ]]; then
    printf 'DEBUG %s Raw:\n%s\n' "$label" "$raw_output"
  fi
}

matches_exception() {
  local expected_exception="$1"
  local actual_exception="$2"
  if [[ "$actual_exception" == "$expected_exception" ]]; then
    return 0
  fi
  if [[ "$actual_exception" == *".$expected_exception" ]]; then
    return 0
  fi
  return 1
}

extract_var_name() {
  local stmt="$1"
  local normalized
  normalized="$(trim "$stmt")"

  if [[ "$normalized" =~ ^(var|let|const)[[:space:]]+([[:alpha:]_][[:alnum:]_]*)[[:space:]]*= ]]; then
    printf '%s' "${BASH_REMATCH[2]}"
    return
  fi

  if [[ "$normalized" =~ ^(final[[:space:]]+)?([^=[:space:]]+)[[:space:]]+([[:alpha:]_][[:alnum:]_]*)[[:space:]]*= ]]; then
    printf '%s' "${BASH_REMATCH[3]}"
    return
  fi

  if [[ "$normalized" =~ ^([[:alpha:]_][[:alnum:]_]*)[[:space:]]*= ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
    return
  fi

  if [[ "$stmt" =~ ^[[:space:]]*([^=]+)[[:space:]]+([[:alpha:]_][[:alnum:]_]*)[[:space:]]*= ]]; then
    printf '%s' "${BASH_REMATCH[2]}"
    return
  fi
  printf ''
}

matches_type() {
  local expected_type="$1"
  local actual_type="$2"
  if [[ "$actual_type" == "$expected_type" ]]; then
    return 0
  fi
  if [[ "$actual_type" == *".$expected_type" ]]; then
    return 0
  fi
  return 1
}

check_expectation() {
  local markdown_file="$1"
  local source_line="$2"
  local input_line="$3"
  local expectation="$4"
  local raw_actual
  raw_actual="$(output_blob)"

  if [[ "$expectation" == "__ANY_OUTPUT__" ]]; then
    normalize_actual_output "throws" "$raw_actual"
    debug_log_normalized "any-output" "$raw_actual"
    if [[ "$NORMALIZED_KIND" == "value" ]]; then
      return
    fi
    fail_mismatch "$markdown_file" "$source_line" "$input_line" "any non-exception output" "$(format_actual_for_display)"
  elif [[ "$expectation" == throws* ]]; then
    local expected_exception
    expected_exception="${expectation#throws }"
    expected_exception="$(trim "$expected_exception")"
    if [[ "$expected_exception" == \{*\} ]]; then
      expected_exception="${expected_exception#\{}"
      expected_exception="${expected_exception%\}}"
    fi

    normalize_actual_output "throws" "$raw_actual"
    debug_log_normalized "throws" "$raw_actual"
    if [[ "$NORMALIZED_KIND" == "throws" ]] && matches_exception "$expected_exception" "$NORMALIZED_EXCEPTION"; then
      return
    fi
    fail_mismatch "$markdown_file" "$source_line" "$input_line" "$expectation" "$(format_actual_for_display)"
  elif [[ "$expectation" == type* ]]; then
    local expected_type
    expected_type="$(trim "${expectation#type }")"
    local var_name
    var_name="$(extract_var_name "$input_line")"
    if [[ -z "$var_name" ]]; then
      fail_mismatch "$markdown_file" "$source_line" "$input_line" "type check requires a named variable assignment" "type <unknown>"
    fi

    if is_java_language "$CURRENT_LANG"; then
      send_and_capture "/vars"
      raw_actual="$(output_blob)"
      normalize_actual_output "type" "$raw_actual" "$var_name"
      debug_log_normalized "type" "$raw_actual"
      if [[ -n "$NORMALIZED_TYPE" ]] && matches_type "$expected_type" "$NORMALIZED_TYPE"; then
        return
      fi
      fail_mismatch "$markdown_file" "$source_line" "$input_line" "$expectation" "$(format_actual_for_display)"
    elif is_js_like_language "$CURRENT_LANG"; then
      send_and_capture "${var_name}.constructor.name"
      raw_actual="$(output_blob)"
      normalize_actual_output "value" "$raw_actual"
      debug_log_normalized "type" "$raw_actual"
      local actual_type
      actual_type="$(strip_wrapping_quotes "$NORMALIZED_DISPLAY")"
      if [[ -n "$actual_type" ]] && matches_type "$expected_type" "$actual_type"; then
        return
      fi
      if [[ -z "$actual_type" || "$actual_type" == "<no output>" ]]; then
        actual_type="<unknown>"
      fi
      fail_mismatch "$markdown_file" "$source_line" "$input_line" "$expectation" "type $actual_type"
    fi
  else
    normalize_actual_output "value" "$raw_actual"
    debug_log_normalized "value" "$raw_actual"
    if [[ "$NORMALIZED_DISPLAY" == *"$expectation"* ]]; then
      return
    fi
    fail_mismatch "$markdown_file" "$source_line" "$input_line" "$expectation" "$(format_actual_for_display)"
  fi
}

process_code_line() {
  local markdown_file="$1"
  local source_line="$2"
  local line="$3"

  local statement="$line"
  local expectation=""

  if [[ "$line" == *"//=> "* ]]; then
    statement="${line%%//=>*}"
    expectation="${line#*//=> }"
    expectation="$(trim "$expectation")"
  elif [[ "$line" == *"//*"* ]]; then
    statement="${line%%//*}"
    expectation="__ANY_OUTPUT__"
  fi

  statement="${statement%${statement##*[![:space:]]}}"

  if [[ -z "$statement" ]]; then
    return
  fi

  send_and_capture "$statement"

  if [[ -n "$expectation" ]]; then
    check_expectation "$markdown_file" "$source_line" "$statement" "$expectation"
  fi
}

process_markdown_file() {
  local markdown_file="$1"
  local in_evidence=0
  local expecting_example=0
  local in_target_block=0
  local block_language=""
  local skip_target_block=0
  local line_no=0
  local has_started_file_scope=0
  local has_alloy_block=0

  printf 'FILE %s\n' "$markdown_file"

  while IFS= read -r line || [[ -n "$line" ]]; do
    line_no=$((line_no + 1))

    if [[ "$line" =~ ^\`\`\`alloy[[:space:]]*$ ]]; then
      has_alloy_block=1
    fi

    if (( in_target_block == 1 )); then
      if [[ "$line" =~ ^\`\`\`[[:space:]]*$ ]]; then
        verbose_log "END Example block at $markdown_file:$line_no"
        in_target_block=0
        skip_target_block=0
        expecting_example=0
        if [[ "$COPROC_SCOPE" == "block" && "$COPROC_RUNNING" == "1" ]]; then
          cleanup_coproc
        fi
        continue
      fi

      if (( skip_target_block == 0 )); then
        process_code_line "$markdown_file" "$line_no" "$line"
      fi
      continue
    fi

    if [[ "$line" == "##### Evidence" ]]; then
      in_evidence=1
      expecting_example=0
      verbose_log "ENTER Evidence at $markdown_file:$line_no"
      continue
    fi

    if [[ "$line" == "#### Scenario:"* ]]; then
      in_evidence=0
      expecting_example=0
      printf 'SCENARIO %s\n' "${line#\#\#\#\# Scenario: }"
      continue
    fi

    if [[ "$line" == "#### "* && "$line" != "#### Scenario:"* ]]; then
      in_evidence=0
      expecting_example=0
      continue
    fi

    if (( in_evidence == 1 )) && [[ "$line" == "- Example:" ]]; then
      expecting_example=1
      verbose_log "FOUND Example marker at $markdown_file:$line_no"
      continue
    fi

    if (( in_evidence == 1 )); then
      if [[ "$line" == "- Implementation:"* ]]; then
        validate_evidence_links "$markdown_file" "$line_no" "Implementation" "${line#- Implementation:}"
        continue
      elif [[ "$line" == "- Test:"* ]]; then
        validate_evidence_links "$markdown_file" "$line_no" "Test" "${line#- Test:}"
        continue
      elif [[ "$line" == "- Test (property):"* ]]; then
        validate_evidence_links "$markdown_file" "$line_no" "Test (property)" "${line#- Test (property):}"
        continue
      elif [[ "$line" == "- Test (integration):"* ]]; then
        validate_evidence_links "$markdown_file" "$line_no" "Test (integration)" "${line#- Test (integration):}"
        continue
      fi
    fi

    if (( expecting_example == 1 )) && [[ "$line" =~ ^\`\`\`([[:alnum:]_+-]+)[[:space:]]*$ ]]; then
      block_language="${BASH_REMATCH[1]}"
      verbose_log "BEGIN Example block ($block_language) at $markdown_file:$line_no"
      if is_supported_language "$block_language"; then
        ensure_coproc "$block_language"
        if [[ "$COPROC_SCOPE" == "file" ]]; then
          has_started_file_scope=1
        fi
      else
        printf -- '--Skipping evidence; %s unsupported\n' "$block_language"
        skip_target_block=1
      fi
      in_target_block=1
      continue
    fi

    if (( expecting_example == 1 )) && [[ -n "$(trim "$line")" ]]; then
      expecting_example=0
    fi
  done < "$markdown_file"

  if (( in_target_block == 1 )); then
    fail_mismatch "$markdown_file" "$line_no" '```' "closing code fence" "unterminated example block"
  fi

  if [[ "$COPROC_SCOPE" == "file" && "$has_started_file_scope" == "1" ]]; then
    cleanup_coproc
  fi

  LAST_FILE_HAS_ALLOY="$has_alloy_block"
}

ARGS=()
while (( $# > 0 )); do
  case "$1" in
    --scope)
      if (( $# < 2 )); then
        usage
        exit 1
      fi
      COPROC_SCOPE="$2"
      shift 2
      ;;
    --verbose)
      VERBOSE=1
      shift
      ;;
    --debug)
      DEBUG=1
      shift
      ;;
    --alloy)
      if (( $# < 2 )); then
        usage
        exit 1
      fi
      ALLOY_MODE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      while (( $# > 0 )); do
        ARGS+=("$1")
        shift
      done
      ;;
    -*)
      printf 'Unknown flag: %s\n' "$1"
      usage
      exit 1
      ;;
    *)
      ARGS+=("$1")
      shift
      ;;
  esac
done

if [[ "$COPROC_SCOPE" != "block" && "$COPROC_SCOPE" != "file" ]]; then
  printf 'Invalid --scope value: %s\n' "$COPROC_SCOPE"
  usage
  exit 1
fi

if (( ${#ARGS[@]} == 0 )); then
  usage
  exit 1
fi

for markdown_file in "${ARGS[@]}"; do
  if [[ ! -f "$markdown_file" ]]; then
    printf 'File not found: %s\n' "$markdown_file"
    exit 1
  fi
done

if [[ -n "$ALLOY_MODE" && ! -e "$ALLOY_MODE" ]]; then
  printf 'Alloy path not found: %s\n' "$ALLOY_MODE"
  exit 1
fi

for markdown_file in "${ARGS[@]}"; do
  process_markdown_file "$markdown_file"
  if [[ "$LAST_FILE_HAS_ALLOY" == "1" ]]; then
    FILES_WITH_ALLOY+=("$markdown_file")
  fi
done

cleanup_coproc
if [[ -n "$ALLOY_MODE" ]]; then
  printf 'MODEL\n'
fi
run_alloy_phase

printf 'Evidence link warnings: %s\n' "$EVIDENCE_WARNING_COUNT" >&2
printf 'Evidence checks passed\n'
