#!/usr/bin/env sh
set -eu

slug="${1:-}"
if [ -z "$slug" ]; then
  echo "Usage: scripts/new-post.sh my-post-slug" >&2
  exit 1
fi

dir="content/posts/$slug"
file="$dir/index.md"

if [ -e "$file" ]; then
  echo "$file already exists" >&2
  exit 1
fi

mkdir -p "$dir"
date_value="$(date '+%Y-%m-%dT%H:%M:%S%z' | sed 's/\(..\)$/:\1/')"

cat > "$file" <<EOF
---
title: "$slug"
date: $date_value
description: ""
tags: []
categories: []
draft: true
ShowToc: true
TocOpen: true
---

EOF

echo "$file"
