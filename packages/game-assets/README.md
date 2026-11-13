# DSH Game Assets

**English** | [简体中文](README.zh-CN.md)

An **Assets** tab beside Chat for game projects: every image of the conversation's workspace as a thumbnail grid, with an answer to the questions a folder of sprites cannot answer by itself.

- **Is this image still used?** The plugin reads the project's code and marks each image *In use*, *Maybe in use* or *Unreferenced*, and lists the lines that refer to it.
- **Which version is live?** Folders that differ only in a version (`cast-v5`, `cast-v9`, `cast-v9-pilot`) are compared side by side: how many images of each the code still refers to.
- **Where did this picture come from?** An image's detail lists the other files of the same name (masters, shipped copies, other versions) and says which are byte-identical.

And it acts on the answers: **retire** images out of the game's way and restore them, **tag** and annotate them, **redraw or generate** pictures with an image API you choose, and **hand a selection to the agent** of the conversation.

It never deletes or overwrites a file. Looking is read-only; the changes it can make to a workspace are listed under [What it changes](#what-it-changes), and each happens only when you ask for it.

## Game projects only

The tab appears only in conversations whose workspace is a game project, and other workspaces are not scanned. A workspace is a game project when it declares an engine:

- an npm dependency on Phaser, PixiJS, Kaboom/KAPLAY, Excalibur, melonJS, LittleJS, Kontra, PlayCanvas, Babylon.js or RPGJS, in the workspace's `package.json` or in a folder directly inside it;
- a Godot (`project.godot`), Unity (`ProjectSettings/`), Unreal (`*.uproject`), Defold, GameMaker, RPG Maker or Cocos Creator project file;
- LÖVE (`main.lua` using `love.`), Bevy, macroquad, ggez, Ebitengine, pygame, Arcade, pyglet, libGDX or MonoGame in its manifest.

The plugin's page under **Plugins** has the settings: show the tab *in game projects only* (default) or *in every conversation*, and for each open workspace *Automatic*, *Always show* or *Never show*. Use *Always show* for a game the detection misses, such as one written without an engine. Inside the tab, **Folders to scan** has *Hide tab for this workspace*.

DSH registers a conversation tab for all conversations at once, so the plugin adds the tab while a conversation on screen belongs to a game project and removes it otherwise. With two conversations side by side, the tab is also there beside the one that is not a game; it then says so instead of scanning.

## What it shows

| | |
| --- | --- |
| **Browse** | A folder tree with counts and a thumbnail grid. Search by name or path, filter by usage or duplicates, sort by file or picture size. Small sprites are enlarged by whole pixels and stay sharp. |
| **Detail** | A large preview, pixel size, file size, version, every reference (file, line and the code around it; a click opens the file beside the conversation), and same-name files elsewhere. |
| **Versions** | Each family of versioned folders with images, in use, maybe and unreferenced counts per version. A version nothing refers to is marked *no references*. |
| **Folders to scan** | Per top-level folder: list its images, and read its code for references. Also where retired images go. |

The copy button puts the paths of the images currently shown on the clipboard, one per line.

## Managing

Tick the box in an image's corner to select it; Shift extends the selection, Ctrl/⌘-click toggles, and the toolbar's checkbox selects everything shown. A bar then offers:

- **Retire…** moves the selection into the retired folder, each image under its present path, after a dialog that says how many of them the code still refers to. The **Retired** filter lists what is there; **Restore** puts images back where they came from. The Versions view retires a whole version from its row, and the detail pane retires or restores one image.
- **Tag…** adds a tag to every selected image or removes one. The detail pane edits one image's tags and its note. A tag menu filters the grid, and the search looks in tags and notes too.
- **Generate…** makes a picture with an [image source](#image-sources), the selected images going along as references (up to four). With one image selected, it is a redraw of that image; the detail pane has **Redraw…** for the same.
- **Ask the agent…** writes a request (check and remove, find where they are used, redraw, or your own words) followed by the selected paths into the conversation's chat input. Nothing is sent until you send it. In a TUI conversation of [Remote Terminals](../remote-terminals/README.md) 0.1.4 or newer, where a terminal stands in for the chat input, the request is typed at the CLI's prompt instead. Where the host cannot take the text, it is copied to the clipboard instead.

## Image sources

Pictures come from image APIs you add under **Image sources**, on the plugin's settings page or from the generate dialog. Two kinds are understood:

| Kind | Speaks | For example |
| --- | --- | --- |
| OpenAI compatible | `POST /images/generations` without references, `POST /images/edits` with them | OpenAI (`https://api.openai.com/v1`, `gpt-image-2`), or a relay service that offers the same routes |
| Gemini | `POST /models/<model>:generateContent`, asked for an image | Google (`https://generativelanguage.googleapis.com/v1beta`, `gemini-3.1-flash-image`), or a relay that offers it |

Each source has a name, an address, a model and an API key; one of them is the default. Keys are kept only on the computer DSH runs on, in `storages/dsh-game-assets/image-sources.json` under the DSH home, readable by its owner alone. The page shows the last four characters of a key and never receives the key itself. Requests to the APIs go out from that computer, for remote workspaces too. Node.js's `fetch` uses `HTTPS_PROXY` only when DSH runs with `NODE_USE_ENV_PROXY=1`; a relay's address is the other way around a network that cannot reach the API.

The dialog sends the prompt, the shape (square, wide or tall, the API's nearest size) and, for an OpenAI-compatible source, whether the background should be transparent. A redraw starts with the image's shape and with transparency on when the image has see-through pixels. Only PNG, WebP and JPEG images can be references; GIF and SVG are left out. Nothing is written until you save:

- The new picture is shown beside the image it redraws, already scaled to that image's pixel size: **Sharp pixels** for small sprites (128 px or less), **Smooth** for the rest, or **Keep the API's size**. A transparent picture is fitted whole; an opaque one, such as a background, is cropped to fill the size.
- **Save as new file** writes it to a free path, by default `<name>-redraw.<ext>` beside the image, or `generated.png` in the folder being looked at.
- **Replace the image** retires the image first (to the retired folder, numbered if an earlier copy is there) and writes the picture at its path, so the code keeps finding it and its tags stay. **Retired → Restore** brings the old one back once the new one is retired.

Closing the dialog while a picture is being generated stops the request. A generation gives up after five minutes.

### What it changes

| In the workspace | When |
| --- | --- |
| Images move into `_retired/<their path>` and back | Retire and Restore |
| `_retired/retired.json` lists where each retired image came from | Retire and Restore |
| `.game-assets.json` holds tags and notes by image path | Tagging and notes |
| A generated picture is written to a free path you chose | Save as new file |
| The image is retired as above, and the picture written at its path | Replace the image |

Both files are plain JSON meant to be committed with the project, so tags travel with it and an agent can read them. The retired folder can be another one per workspace (**Folders to scan** → *Retired images go to*), for example `assets/art-retired`; it must be a visible folder inside the workspace. Folders that a move leaves empty are removed.

Only images the last scan listed can be moved, tagged or replaced. A move never replaces a file: if the target exists, the image stays where it is and is reported. A picture is written beside its place under a hidden name and then linked into it, so it appears whole or not at all and never over an existing file; if that fails after a replaced image was retired, the image is moved back. Retired images are not matched against code, so they never count as in use; an image already in the retired folder without an entry in the list is shown as retired but cannot be restored from here.

Outside the workspace the plugin saves only your settings (where the tab appears, which folders each workspace scans and its retired folder) and your image sources, under the DSH home.

## How usage is decided

The code is read as text; nothing is run. A reference is one of:

| Reference | Example | Verdict |
| --- | --- | --- |
| path | `'art/cats/idle.png'`, or a file name only one image has | In use |
| built path | `` `cats/${breed}-walk.png` `` | Maybe in use |
| folder | `'art/props/'`, from which paths are joined | Maybe in use |
| name only | a bare name several images share, or the name without its extension, such as a texture key | Maybe in use |

An image with no reference at all is *Unreferenced*. Paths match by their ending and without regard to the image extension, so `art/cats/idle.png` in code finds both `public/art/cats/idle.gif` and a master `assets/masters/art/cats/idle.png`.

Manifests, atlases and maps (`.json`, `.yaml`, `.xml`, `.atlas`, `.tmx` and similar) count only once code, or another counted file, names them. Metadata that a generator leaves beside its images would otherwise mark every image it lists as used.

**Which code counts is yours to choose.** By default every top-level folder is read as code except build output (`dist`, `build`, `docs`, `artifacts` …) and art folders: folders that are nearly all images and hold a sliver of the project's code. Under **Folders to scan**, switch *Code* off for build scripts or tools to see only what the game itself loads, or on for a folder the default left out.

### Limits

- The verdict is static analysis. *Unreferenced* means no code in the folders being read mentions the file; *Maybe in use* means check before deleting.
- Engines that refer to assets by ID rather than by path (Unity GUIDs, Cocos Creator UUIDs) are not understood. Path-based projects work: Phaser, PixiJS, Godot (`res://` paths), LÖVE, plain web games.
- Images only: PNG, GIF, WebP, JPEG and SVG. Hidden folders, `node_modules` and symbolic links are skipped.

## Remote workspaces

A conversation whose workspace is on a machine saved in [Remote Agents](../remote-agents/README.md) works the same way: the tab, the verdicts, retiring, tags, generated pictures and the agent hand-off. It needs Remote Agents 0.2.130 or newer on the DSH host and Node.js 18 or newer on the remote machine, which Remote Agents asks for as well.

The work is done on that machine. The plugin sends one small script to `node` over the connection Remote Agents already holds, runs it in the conversation's folder, and reads back the answer; nothing is installed there. Each scan is a new process, so what it measured (image sizes and hashes of unchanged files) is kept under `~/.dsh-remote-agents/game-assets/` on the machine to make the next scan quick. Thumbnails that are asked for together are fetched in one round trip. Expect the first scan and the first screen of thumbnails to take longer than on a local folder.

Settings of a remote workspace are kept by machine and folder. Retired images, the tag file and saved pictures are written on the remote machine, in its copy of the project. A picture travels there by Remote Agents' file upload, into `.dsh-remote-agents/attachments/game-assets/` in the workspace, is checked against its SHA-256 and moved into place; the upload is removed either way.

## Install

```sh
pnpm --filter dsh-game-assets pack:plugin
dsh plugin --profile web add "$PWD/dist/dsh-game-assets-0.2.1.tgz"
```

Restart the profile and refresh the browser. For Desktop, quit DSH and use its bundled `dsh` with `--profile desktop`. Requires DSH `>=0.2.1-rc.2 <0.3.0`.

## Development

```sh
pnpm --filter dsh-game-assets check        # type-check, test, build
pnpm --filter dsh-game-assets preview:ui   # the tab outside DSH, over the current folder
node scripts/preview.mjs /path/to/game 4184
```

The host half (`src/`) scans and serves images through `/api/game-assets`; `src/workspace.ts` is what it does in one folder, run in the host's process for a local workspace and inside `src/remote-agent.ts`, the script sent to the machine, for a remote one; the client half (`src/client/`) is the tab. `src/references.ts` holds the reference rules and is the place to teach it a new way code names a file; `src/manage.ts` is everything that changes a workspace; `src/sources.ts` keeps the image sources and calls their APIs, and `src/client/generate.tsx` is the dialog; `src/detect.ts` lists the engines that make a workspace a game project.

MIT.
