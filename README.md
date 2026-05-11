# FreeMoCap Web

A small browser UI for selecting existing `.mp4` videos, previewing them, and running Skelly synchronization into the standard FreeMoCap recording-folder layout.

This project intentionally does not implement live camera recording, motion tracking, reconstruction, export, or Blender processing. Those responsibilities stay in the upstream `freemocap` package and its dependencies.

## Run

```bash
uv run freemocap-web
```

Then open http://127.0.0.1:8000.

## What It Does

- Accepts two or more `.mp4` uploads from the browser.
- Shows selected videos in the UI before upload.
- Starts a background Skelly synchronization job and polls progress in the UI.
- Saves synchronized results to `freemocap_data/recording_sessions/<recording_name>/synchronized_videos`.
- Calls `skelly_synchronize` for audio or brightness synchronization, matching the FreeMoCap desktop import path.
- Reads recording status through FreeMoCap's `RecordingInfoModel`.

For multi-camera processing after import, continue with the FreeMoCap processing tools and provide the calibration `.toml` required by upstream FreeMoCap.
