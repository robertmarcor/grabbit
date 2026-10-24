# Grabbit

A Chrome extension that grabs videos, HLS streams and audio from the page you are on, with thumbnails, a quality picker and automatic video+audio merging. No build step, account, external service or companion app needed.

By installing or using Grabbit you agree to the [Terms of Service](TERMS.md). The popup asks you to accept them once before first use.

## Install

1. Extract the ZIP to a permanent folder if you downloaded the ZIP.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** in the upper-right corner.
4. Click **Load unpacked** and select the extension folder containing `manifest.json`.
5. Pin Grabbit using Chrome's Extensions menu.

Keep the extracted folder: Chrome loads the extension from there.

## Use

1. Reload the video page after installing the extension, then start playing the video. The badge counts what was found.
2. Click Grabbit. Each find shows as a card: thumbnail, page title, size or duration, and an **HLS** or **HTTP** tag.
3. For HLS streams, pick a quality (1080p, 720p, ...), then click **Download**. Progress shows on the card, and you can close the popup while it runs.
4. Files go to your Downloads folder. Use **×** to remove a card and **Scan** to check the page again.

## Scope and limitations

- **HTTP**: direct video/audio files (mp4, webm, mov, mkv, mp3, m4a, ogg, opus, wav, flac) are handed to Chrome's downloader.
- **HLS** (`.m3u8`): the chosen quality is downloaded segment by segment, AES-128 parts are decrypted, and everything is joined into one file. Streams with fMP4 segments become `.mp4`. Classic MPEG-TS streams are saved as `.ts`, which plays in VLC and Windows Media Player; convert it with `ffmpeg -i in.ts -c copy out.mp4` if you need MP4.
- **Separate picture and sound.** Many sites serve video and audio as two files. Cards are tagged **VIDEO ONLY** or **AUDIO**. A video-only card gets a "+ Audio" picker, and **Download** saves one `.mp4` with sound. The result is a regular (non-fragmented) MP4 that plays in Windows Media Player, VLC and browsers. The merge runs in the browser with no ffmpeg needed, for fragmented MP4 (DASH-style) files and fMP4 HLS streams.
- HLS streams in the older `.ts` format that keep audio separate still save as two files (`<name> (audio)`). Join them with `ffmpeg -i video.ts -i audio.aac -c copy out.mp4`.
- The thumbnail is the current video frame when the page allows it, otherwise the poster/og:image or a screenshot of the tab.
- Downloads send the video page as Referer/Origin, which gets past most hotlink checks.
- Not supported: DRM (Widevine/FairPlay/SAMPLE-AES), DASH (`.mpd`), byte-range HLS, live streams (only the current window is saved), and blob: URLs.
- HLS downloads are held in memory until joined, so a 2 GB movie needs a few GB of free RAM.
- YouTube is blocked (pages, embedded players and its video servers), in line with Chrome Web Store policy.
- Use it for videos you have permission to save.

## Permissions and privacy

Website access plus `webRequest` let the extension spot media responses, including media from a separate CDN. `scripting` and `activeTab` scan the page and take the thumbnail. `downloads` saves files. `offscreen` joins HLS segments. `declarativeNetRequestWithHostAccess` sets the Referer on the extension's own download requests. `storage` keeps the list in session storage.

No analytics, remote code, or uploads. Full detected URLs (which can include temporary access tokens) are stored locally for the browser session, cleared for a tab on full navigation or close. Copying a signed URL may share its temporary access. Chrome manages downloaded files separately. You can limit site access in Chrome's extension settings, but detection may then miss media from other hosts.

## Validation

Detection, filename, HLS playlist parsing and the video+audio merge have automated Node tests (`node --test`). JavaScript syntax is checked. Live Chrome installation and downloads have not been verified in this environment.

Manual check: open a page with a direct MP4, reload and play it, check the badge, open the popup, download and play the saved file. Check that full navigation clears previous entries and restricted pages display guidance.

Built with Manifest V3 and Chrome's documented APIs:
- https://developer.chrome.com/docs/extensions/reference/api/webRequest
- https://developer.chrome.com/docs/extensions/reference/api/downloads

All source files are included and can be edited directly. Click Reload on the extension's card after editing.

## License

MIT. See [LICENSE](LICENSE). Use is also subject to the [Terms of Service](TERMS.md).
