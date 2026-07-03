# Webtoon Portrait Mode

<p align="center">
  <img src="store_assets/store_icon_128.png" width="128" height="128" alt="Webtoon Portrait Mode icon">
</p>

Webtoon Portrait Mode is a lightweight Chrome extension that improves the Webtoon desktop reader on portrait monitors and large displays. It can fit episode panels to the available width, reduce distractions, preload nearby images, and navigate between episodes with deliberate scroll gestures.

> This is an independent reader customization project and is not affiliated with or endorsed by WEBTOON Entertainment Inc.

## Features

- **Fit to Screen** — Resize episode panels to match the available screen width.
- **Adjustable Width** — Choose a reading width from 40% to 100%.
- **Zen Mode** — Hide distracting page elements while reading.
- **Reading Background** — Select black, dark navy, dark gray, or the original site color.
- **Hide Cursor** — Automatically hide the mouse cursor over the reader.
- **Episode Navigation** — With `Auto-Next Episode` enabled:
  - Scroll past the bottom to open the next episode.
  - Scroll past the top to return to the previous episode.
- **Adaptive Image Preloading** — Keep nearby panels ready after Fit to Screen changes their rendered size.
- **Dark Comments** — Apply the selected dark background to comments, expanded replies, and the reply editor.
- **English and Thai UI**.

## Installation

### Load the extension locally

1. Download or clone this repository.
2. Open `chrome://extensions` in Google Chrome.
3. Enable **Developer mode**.
4. Select **Load unpacked**.
5. Choose the repository folder containing `manifest.json`.
6. Open a Webtoon episode and select the extension icon to configure the reader.

### Install a packaged build

Release ZIP files are created in the `release/` directory. Extract the ZIP before using **Load unpacked**; Chrome cannot load the ZIP directly through that option.

## Usage

| Setting | Description |
| --- | --- |
| Fit to Screen | Expands episode panels to the selected reading width. |
| Width | Sets the panel width between 40% and 100%. |
| Zen Mode | Hides sidebars, advertisements, comments, and other distractions. |
| Hide Cursor | Hides the cursor while reading and briefly shows it after interaction. |
| Auto-Next Episode | Enables deliberate scroll navigation at both the top and bottom boundaries. |
| Background | Changes the reader and supported page surfaces to the selected color. |

Settings are saved locally and apply automatically on supported Webtoon pages.

## Supported Pages

The content script runs only on:

```text
https://*.webtoons.com/*
```

Viewer-specific behavior activates only on episode viewer pages.

## Development

The project uses plain HTML, CSS, and JavaScript with Manifest V3. No dependency installation or build step is required.

### Run checks

Requires a current Node.js installation:

```powershell
node --check content.js
node --check popup.js
node --test tests\content.test.cjs
```

The automated checks cover image preload behavior, settings validation, previous/next episode resolution, comment reply backgrounds, Manifest V3 configuration, popup accessibility, localization, and Store asset dimensions.

### Create a release ZIP

On Windows PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\package-extension.ps1
```

The packaging script runs all checks first and then creates an allowlisted ZIP in `release/`. Development files, tests, and Store artwork are excluded from the extension package.

## Project Structure

```text
.
├── manifest.json             # Manifest V3 configuration
├── content.js                # Reader styles and page behavior
├── popup.html                # Extension popup
├── popup.css                 # Popup styles
├── popup.js                  # Settings and localization logic
├── _locales/                 # English and Thai translations
├── icons/                    # Runtime extension icons
├── scripts/                  # Release packaging script
├── store_assets/             # Chrome Web Store artwork
└── tests/                    # Node.js regression tests and fixtures
```

## Contributing

Bug reports and focused pull requests are welcome. When changing reader behavior:

1. Keep permissions minimal.
2. Do not add remote JavaScript or analytics.
3. Preserve Webtoon's native document flow and lazy-loading behavior.
4. Add or update regression tests.
5. Test with Fit to Screen both enabled and disabled.

When reporting a display issue, include the page locale, a screenshot, and the affected DOM class if available.

