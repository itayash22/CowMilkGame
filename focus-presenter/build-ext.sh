#!/usr/bin/env bash
# Build the Manifest V3 extension variant into extension/ from the same src/.
# MV3 extension pages forbid inline <script>, so unlike the single-file build
# the scripts are shipped as separate packaged files (and the pdf.js worker is
# loaded by URL instead of from an inlined blob — see src/app.js).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p extension/vendor
# part1.html ends with an opening <script> tag for the single-file build; strip it
head -n -1 src/part1.html > extension/index.html
{
  printf '<script src="vendor/pdf.min.js"></script>\n'
  printf '<script src="app.js"></script>\n'
  printf '</body>\n</html>\n'
} >> extension/index.html
cp src/app.js extension/app.js
cp vendor/pdf.min.js vendor/pdf.worker.min.js extension/vendor/
echo "Built extension/ ($(du -sh extension | cut -f1))"
