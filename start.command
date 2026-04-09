#!/bin/bash
cd "$(dirname "$0")"
echo ""
echo "  ╔═══════════════════════════════════════╗"
echo "  ║         BashBeats Server              ║"
echo "  ║   http://localhost:8888               ║"
echo "  ║   Press Ctrl+C to stop                ║"
echo "  ╚═══════════════════════════════════════╝"
echo ""
open http://localhost:8888
python3 -m http.server 8888
