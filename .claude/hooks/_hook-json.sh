#!/usr/bin/env bash

hook_read_fields() {
	local prog='try{const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const t=d.tool_input||{};const s=v=>typeof v==="string"?v.replace(/[\r\n]+/g," "):"";process.stdout.write([s(d.tool_name),s(t.file_path),s(t.command)].join("\n"))}catch(e){process.exit(3)}'
	if command -v bun >/dev/null 2>&1; then
		bun -e "${prog}"
	elif command -v node >/dev/null 2>&1; then
		node -e "${prog}"
	elif command -v jq >/dev/null 2>&1; then
		jq -j '[(.tool_name // ""), (.tool_input.file_path // ""), (.tool_input.command // "")] | map(gsub("[\r\n]+"; " ")) | join("\n")'
	else
		return 3
	fi
}
