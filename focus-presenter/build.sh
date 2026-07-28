#!/usr/bin/env bash
# Assemble the single-file, fully offline FocusPresenter.html:
# app shell + inlined pdf.js + inlined pdf.js worker (loaded via blob URL) + app code.
set -euo pipefail
cd "$(dirname "$0")"
{
  cat src/part1.html
  cat vendor/pdf.min.js
  printf '\n</script>\n<script type="text/plain" id="pdf-worker-code">\n'
  cat vendor/pdf.worker.min.js
  printf '\n</script>\n<script>\n'
  cat src/app.js
  printf '\n</script>\n</body>\n</html>\n'
} > FocusPresenter.html
echo "Built FocusPresenter.html ($(wc -c < FocusPresenter.html) bytes)"
