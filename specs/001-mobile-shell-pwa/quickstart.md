# Quickstart: Validate Mobile-Comparable + PWA

**Feature**: `001-mobile-shell-pwa`  
**Date**: 2025-12-28

## Run locally

1) Install dependencies and start dev server:\n+\n+```bash\n+npm install\n+npm run dev\n+```\n+\n+2) Open the app and use device emulation:\n+- iPhone: 390×844 (Safari/Chrome)\n+- Android: 360×800\n+- iPad: 768×1024 and 1024×768

## Validate “golden tasks”

- Mobile navigation: switch Inbox/Boards/Contatos/Atividades without overlap\n+- Deal flow: open deal → move stage → mark won/lost\n+- Activity: create + complete an activity without keyboard hiding CTA\n+- PWA: install prompt appears (eligible browsers) and app launches from home screen

## PWA notes

- PWA installation requires:\n+  - valid manifest\n+  - served over HTTPS (production/staging)\n+- iOS behavior differs:\n+  - no standard `beforeinstallprompt`\n+  - user installs via “Share → Add to Home Screen”
