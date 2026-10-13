# open-image-2-generator

A SillyTavern image-generation script that runs on the **JS-Slash-Runner** extension (TavernHelper).

It keeps the normal text-to-image flow and adds a per-character reference image library, so a generated
`<pic prompt="...">` can be sent to the image API as an image-to-image request together with the matching
character's reference art.

The whole thing is one file:

| File | What it is |
| --- | --- |
| `open_image2_character_reference.json` | Exported TavernHelper script (`type: script`) — the actual generator |

## Where everything lives

This repo only holds the script. The two projects it runs inside are reachable through `link/`:

```
link/
├── JS-Slash-Runner  ->  D:\programming\silly\JS-Slash-Runner   (TavernHelper extension, v4.11.3)
└── SillyTavern      ->  D:\programming\SillyTavern             (SillyTavern 1.18.0)
```

`link/` is git-ignored on purpose — the two entries are Windows directory junctions, so read and edit the
real repos through them. Deleting a path *inside* one of them deletes the real repo's file; deleting the
entry itself only detaches the junction. In this SillyTavern install the extension is actually loaded from:

```
SillyTavern/data/default-user/extensions/JS-Slash-Runner
```

## Installing / updating the script

1. Start SillyTavern.
2. Open the TavernHelper panel → script library.
3. Use **导入脚本文件 / Import script file** and pick `open_image2_character_reference.json`.
4. Enable the script and open the `image2` panel (also reachable from its script button).

The file is a plain export, so re-importing an edited copy is the normal way to update it.

## Defaults it ships with

- Image API: `http://127.0.0.1:8199/v1/images/generations` (OpenAI-compatible) — change `serviceUrl` if your
  backend listens elsewhere.
- Model: `gpt-image-2`
- `referenceEnabled: true` — match reference images by character name / alias and attach them to the request.
- Settings persist as TavernHelper script variables (`oair_image2_character_reference_settings_v2`);
  reference images themselves are kept in the browser's IndexedDB (`oair_image2_character_reference_v1`).

## Notes

- See `AGENTS.md` for the rules on working with `link/`.
- The script hooks `GENERATION_AFTER_COMMANDS` and `MESSAGE_RECEIVED`, and reads chat/script variables via the
  TavernHelper API. It does not patch SillyTavern or extension source.
- Its UI text is Chinese.
