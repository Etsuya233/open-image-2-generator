# open-image-2-generator

A native SillyTavern UI extension. `index.js` loads the modules in `src/`; `style.css` holds the UI styles.
`README.md` covers installation, migration, and the local development junction.
Edit the extension sources directly; `open_image2_character_reference.json` is the archived TavernHelper version.
The extension uses ST native APIs and must run without TavernHelper. Local source edits take effect after a page refresh.

## link/ is a window into the real repos

`link/JS-Slash-Runner` and `link/SillyTavern` are Windows directory junctions pointing at
`D:\programming\silly\JS-Slash-Runner` and `D:\programming\SillyTavern`.

- Any path under `link/<name>/` **is** a path in the target repo — reading, editing, moving, and deleting
  there all land on the real thing. Before writing to such a path, confirm the change belongs to that repo.
  Use `tmp/` for scratch work, and keep `link/` free of generated or experimental files.
- To detach a link entry itself, remove it by name: `rm -r link/<name>` or `cmd //c rmdir link\<name>`.
  Measured on this machine: both drop the junction and leave the target repo untouched, as do `shutil.rmtree`
  (refuses) and `git clean -xfd`.
- Depth is the whole rule. A command whose paths stop at the entry — `rm -r link/*`, `rm -r link/<name>`,
  `git clean -xfd`, an IDE "remove folder" — detaches junctions and leaves the repos intact. A command whose
  paths descend below one — `rm -rf link/<name>/*`, `rsync --delete`, `robocopy /MIR` — writes to the real
  repo, because there is no copy to protect. So resolve the path depth before running a bulk delete or sync
  under `link/`, and keep bulk operations off that tree.
