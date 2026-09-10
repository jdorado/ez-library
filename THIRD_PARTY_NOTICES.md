# Third-party notices

Library code is MIT licensed. QMD 2.8.3 is an unmodified MIT-licensed dependency by its upstream contributors: https://github.com/tobi/qmd. Its npm package retains its license. The frozen dependency graph includes native SQLite/vector and llama.cpp bindings; their notices remain in the installed dependency packages. No dependency license is replaced by this repository's LICENSE.

The runtime uses the official Node/Debian container distribution. Its component licenses remain applicable; the image contains the installed packages and their notices. QMD model weights are not bundled or redistributed by this package. An explicit `qmd pull` downloads upstream models into private runtime state; their licenses and download terms apply separately. Downloaded models and document content never belong in the npm artifact.

PDF text extraction uses unmodified Debian Poppler utilities (GPL-2.0-or-later), as a separate subprocess. Copyright and license notices are retained in /usr/share/doc/poppler-utils and libpoppler packages in the image; Debian distributes the corresponding source packages.
