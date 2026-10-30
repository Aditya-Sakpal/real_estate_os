import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A production build tried on this machine goes to its own folder, so it
  // never overwrites the running dev server's `.next` (which corrupts it).
  distDir: process.env.NEXT_DIST_DIR || ".next",
  experimental: {
    authInterrupts: true,
    // Reference media is capped at 25 MB, and a server action body carries
    // the file plus the rest of the form. Next's default is 1 MB, which
    // refuses the upload before any of our own rules get to see it, with an
    // error that names none of this.
    serverActions: { bodySizeLimit: "28mb" },
  },
  // The floating dev badge sits on top of the rail's footer; nothing in the
  // console needs it and it obscures real UI while designing.
  devIndicators: false,
  // OpenCV is a WebAssembly build of several megabytes that finds the QR the
  // image model drew. Bundling it gains nothing and slows every compile, so
  // it is loaded from node_modules at run time.
  serverExternalPackages: ["@techstark/opencv-js", "tesseract.js", "pdfjs-dist", "@napi-rs/canvas", "@node-saml/node-saml"],
  // Read from disk at run time by the post designer, so a deployment has to
  // carry them: the template library and the bundled Noto faces. The video
  // clips (about 800 MB) are kept out of git, so a deployment built from the
  // repository carries none; where they exist they ride only with the
  // campaign routes that list, serve and design from them.
  outputFileTracingIncludes: {
    // OpenCV is loaded through createRequire at run time, which the tracer
    // cannot follow, so without this a deployment has no copy of it.
    "/dashboard/**": ["./template_library/image-ads-templates/**/*", "./template_library/carousel-ads-templates/**/*", "./assets/fonts/**/*", "./node_modules/@techstark/opencv-js/package.json", "./node_modules/@techstark/opencv-js/dist/**/*",
      // The pixel gate's OCR: its worker thread and its LSTM cores are loaded
      // by path at run time, and the English model is read from node_modules.
      "./node_modules/tesseract.js/package.json", "./node_modules/tesseract.js/src/**/*", "./node_modules/tesseract.js-core/package.json", "./node_modules/tesseract.js-core/index.js", "./node_modules/tesseract.js-core/*lstm*", "./node_modules/@tesseract.js-data/eng/4.0.0_best_int/*",
      // Brain documents: pdf.js, its fake worker and the files it reads by
      // path (fonts a PDF names but does not embed, CMaps, decoders), and the
      // canvas it draws a scanned page on.
      "./node_modules/pdfjs-dist/package.json", "./node_modules/pdfjs-dist/legacy/build/*.mjs", "./node_modules/pdfjs-dist/standard_fonts/*", "./node_modules/pdfjs-dist/cmaps/*", "./node_modules/pdfjs-dist/wasm/*", "./node_modules/pdfjs-dist/iccs/*", "./node_modules/@napi-rs/canvas/**/*", "./node_modules/@napi-rs/canvas-linux-x64-gnu/**/*"],
    // The Brain's document reader reads a scanned Devanagari page with the
    // Hindi and Marathi models, from node_modules like the English one.
    "/dashboard/brain/**": ["./node_modules/@tesseract.js-data/hin/4.0.0_best_int/*", "./node_modules/@tesseract.js-data/mar/4.0.0_best_int/*"],
    "/dashboard/campaigns/**": ["./template_library/video-ads-templates/*/*.mp4", "./template_library/video-ads-templates/*/*.jpg", "./template_library/video-ads-templates/clips.json"],
    // The example picture Meta is shown with a broadcast template for review.
    "/dashboard/settings/**": ["./assets/whatsapp/*"],
  },
  // admin.salesdesk.app is the operator console (src/app/admin), served
  // from this same deployment: every path on that host is its /admin page,
  // and the console's pages answer on no other host.
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: "/:path((?!_next/|favicon\\.ico$|icon\\.svg$|apple-icon\\.png$).*)",
          has: [{ type: "host", value: "admin\\..+" }],
          destination: "/admin/:path",
        },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
