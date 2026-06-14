#!/usr/bin/env bash
# Render the store assets to exact-dimension, no-alpha JPEGs (Chrome Web Store ready).
set -e
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
cd "$(dirname "$0")"
mkdir -p out

render() { # 1=html 2=w 3=h 4=outname
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=1 --virtual-time-budget=2500 \
    --default-background-color=FFFFFFFF \
    --screenshot="out/$4.png" --window-size="$2,$3" "file://$PWD/$1" >/dev/null 2>&1
  # JPEG = 24-bit, no alpha (what the store wants); high quality.
  sips -s format jpeg -s formatOptions 92 "out/$4.png" --out "out/$4.jpg" >/dev/null 2>&1
  rm -f "out/$4.png"
}

render screen-1-detect.html   1280 800  screenshot-1-detect-1280x800
render screen-2-scrub.html    1280 800  screenshot-2-scrub-1280x800
render screen-3-local.html    1280 800  screenshot-3-local-1280x800
render screen-4-coverage.html 1280 800  screenshot-4-coverage-1280x800
render promo-small.html        440 280  promo-small-440x280
render promo-marquee.html     1400 560  promo-marquee-1400x560
echo "rendered:"; ls out
