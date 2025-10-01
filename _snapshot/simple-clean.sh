#!/usr/bin/env bash
# Kills GUI + static servers quickly
pkill -f gui-server.cjs 2>/dev/null
pkill -f server.cjs 2>/dev/null
echo "Killed any running gui-server.cjs and server.cjs"
