# Third-party notices

Prism Stage's original application code is licensed under MIT. This does not change the licenses of its dependencies, fonts, or pretrained models. The versions below are the runtime packages pinned by this repository; `package-lock.json` records the complete dependency graph. Upstream projects and authors do not endorse Prism Stage.

## Distributed runtime components

| Component | Version | License and copyright |
| --- | --- | --- |
| [React](https://github.com/facebook/react) and React DOM | 19.2.0 | MIT; Copyright (c) Meta Platforms, Inc. and affiliates. |
| React Scheduler | 0.27.0 | MIT; Copyright (c) Meta Platforms, Inc. and affiliates. Transitive runtime dependency of React DOM. |
| [Three.js](https://github.com/mrdoob/three.js) | 0.180.0 | MIT; Copyright © 2010–2025 three.js authors. |
| [Rapier JavaScript / `@dimforge/rapier3d-compat`](https://github.com/dimforge/rapier.js) | 0.19.3 | [Apache-2.0](https://github.com/dimforge/rapier.js/blob/master/LICENSE); Dimforge and Rapier contributors. Includes its physics WebAssembly implementation. |
| [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe) | 1.0.1 | [Apache-2.0](https://github.com/google-ai-edge/mediapipe/blob/master/LICENSE); Google and MediaPipe contributors. Includes its JavaScript and WASM distribution. |
| [fflate](https://github.com/101arrowz/fflate) | 0.8.3 | MIT; Copyright (c) 2023 Arjun Barrett. |
| [idb](https://github.com/jakearchibald/idb) | 8.0.3 | ISC; Copyright (c) 2016, Jake Archibald <jaffathecake@gmail.com>. |
| [Lucide React](https://github.com/lucide-icons/lucide) | 0.468.0 | ISC, with Feather-derived portions under MIT. Copyright (c) for portions held by Cole Bemis 2013–2022 as part of Feather; other portions by Lucide Contributors 2022. |
| [Inter via Fontsource](https://fontsource.org/fonts/inter) | `@fontsource-variable/inter` 5.2.8 | SIL Open Font License 1.1; Copyright 2016 The Inter Project Authors ([upstream](https://github.com/rsms/inter)). |

Build and test tools (including Vite, TypeScript, Vitest, tsx, and fake-indexeddb) remain under their package licenses. They are not vision services and are not needed to run the deployed application. License files remain available in an installed dependency's package directory.

## Pretrained vision models

These are **unmodified Google pretrained models**, not models trained by Prism Stage. The model cards explicitly identify Apache License 2.0. The binary files are downloaded from the versioned official URLs below. They are hosted with the app for local inference.

| Model | Fixed source and documentation |
| --- | --- |
| Hand Landmarker full, float16, version 1 | [Versioned task bundle](https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task); [official model card, license on page 2](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Hand%20Tracking%20(Lite_Full)%20with%20Fairness%20Oct%202021.pdf); [task documentation](https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker). |
| Selfie Segmenter landscape, float16, version 1 | [Versioned TFLite model](https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter_landscape/float16/1/selfie_segmenter_landscape.tflite); [official model card, license on page 1](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MediaPipe%20Selfie%20Segmentation.pdf); [task documentation](https://developers.google.com/edge/mediapipe/solutions/vision/image_segmenter). Model card authors: Tingbo Hou, Siargey Pisarchyk, and Karthik Raveendran, Google. |

Checksums, byte sizes, runtime version, and source URLs are recorded in [the model asset manifest](public/models/manifest.json). The complete Apache License 2.0 is distributed in [LICENSE-APACHE-2.0.txt](public/models/LICENSE-APACHE-2.0.txt), and applies to the Apache-licensed models and runtime components above. Prism Stage supplies separate original input stabilization and artwork rendering around those components. The application also installs a worker-level same-origin fetch restriction to block the SDK's observed external telemetry attempts; this is a surrounding application control, not a claim that the upstream SDK contains no telemetry code.

The hand model is intended for visible, prominent hands; occlusion and image quality affect results. The selfie model is a person segmenter and may miss thin features or include multiple people. Read the model cards for intended use and limitations. Prism Stage uses these models for creative interaction and does not implement identity recognition.

## Research references and demonstration assets

[RESEARCH.md](docs/RESEARCH.md) records nine inspected projects and their source/license links. They are references, not bundled dependencies. No code or media was copied from `bhavyantu/invisible-cloak`, `collidingScopes/iron-interface`, or `Mruchus/dance-sync-analysis`, whose inspected repositories did not contain a LICENSE file. Public repository access alone is not treated as permission to reuse their work. Robust Video Matting's GPL code and weights are not bundled.

Procedural demo motion, generated masks used in demo mode, palettes, shaders, sample project parameters, and artwork rendered from those samples are created for Prism Stage. Demo provenance is retained in project files. A demo mask is not presented as a real segmentation result. Third-party music, dance clips, avatars, and research-project screenshots are not part of the application's sample assets. Any separately documented validation footage keeps its own source and permission record and is not relicensed by the application.

The processed observations in `tests/fixtures/*-gestures.prismstage` derive from
Google's Apache-2.0 MediaPipe test video, at the exact commit and checksum recorded
in [validation-assets.json](docs/validation-assets.json). Copyright Google LLC and
MediaPipe contributors. The test projects store hand positions/person masks, not
the original RGB footage. They retain the source's Apache-2.0 provenance; see
[the fixture explanation](tests/fixtures/README.md). The original videos are fetched
only for optional local validation and are not distributed with the application.

## MIT permission notice

The following notice applies to the MIT components identified above, with their respective copyright statements retained in the table. The Feather portions of Lucide are also covered by this permission notice.

```text
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## ISC permission notices

### idb

```text
ISC License (ISC)
Copyright (c) 2016, Jake Archibald <jaffathecake@gmail.com>

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
```

### Lucide

```text
ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of
Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

## Inter font license

Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter).

```text
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```
