---
name: session-progress-counter
description: Use when tracking counts, rate, or ETA. Report actual work.
version: 1.0.0
author: Ilya Lubenets (ormeilu), Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [hermes-desktop, progress]
---

# Report measured session progress

Use the ordinary `todo_list` for stages. Session Progress counts completed leaf tasks automatically. Use an explicit counter when you have a measured total such as files, records, or tests.

1. Keep one `todo_list` item with a stable ID `progress:<slug>`. The slug is 1–32 lowercase ASCII letters, digits, or hyphens and starts with a letter or digit.
2. Set `content` to `done/total unit`, for example `120/500 files`. Use a decimal point for fractions and no thousands separators. Use the same unit throughout; `total` must be positive, and `done` must be between zero and `total` inclusive. The unit is 1–24 characters and starts with a letter.
3. Use `merge: true` to update the item without replacing the checklist. Keep it `pending` until the actual count reaches the target, then mark it `completed`. Mark it `cancelled` to stop reporting the counter.
4. Update after meaningful batches. Read the actual count before each update. If the total changes, report the revised total with the observed count.

The Desktop plugin estimates rate and ETA from measured changes. Do not invent counts, count rejected items toward an accepted-items target, or supply an ETA on the plugin's behalf. If the total is unknown, use a real stage checklist or leave progress unquantified.
