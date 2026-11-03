#!/bin/zsh
cd "${0:A:h:h}" || exit 1
exec /usr/bin/env node scripts/dsh-runtime.mjs open
