#!/bin/bash
# Local development install for Linux dock/taskbar integration
# Run this after building, then restart the app with 'npm start'
set -e

ICON_SRC="build/icons/icon.png"
DESKTOP_SRC="build/whatsapp-linux.desktop"

# Install icon to user theme directory (required for .desktop Icon=whatsapp-linux)
mkdir -p ~/.local/share/applications
mkdir -p ~/.local/share/icons/hicolor/256x256/apps
mkdir -p ~/.local/share/icons/hicolor/48x48/apps
cp "$ICON_SRC" ~/.local/share/icons/hicolor/256x256/apps/whatsapp-linux.png
cp build/icons/icon-48.png ~/.local/share/icons/hicolor/48x48/apps/whatsapp-linux.png 2>/dev/null || cp "$ICON_SRC" ~/.local/share/icons/hicolor/48x48/apps/whatsapp-linux.png

# Update desktop icon reference to absolute for safe local testing
cp "$DESKTOP_SRC" ~/.local/share/applications/whatsapp-linux.desktop

echo "Installed to ~/.local/share/applications/whatsapp-linux.desktop"
echo "Installed icons to ~/.local/share/icons/hicolor/"
echo "Restart with 'npm start' and the dock should associate correctly."
