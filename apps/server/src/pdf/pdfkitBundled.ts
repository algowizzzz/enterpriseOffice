/**
 * pdfkit, in the only shape that works from a single bundled file.
 *
 * See `pdfkit-shim.d.ts` for why the ordinary entry cannot be used. The path
 * below reaches past the package's export map on purpose: esbuild, Vite and
 * TypeScript all follow a file path, and none of them will hand out the browser
 * build by package name while the `node` condition is set.
 *
 * The built-in fonts are registered here, once, as plain data that the bundler
 * inlines. Symbol and ZapfDingbats are left out: nothing draws with them, and
 * a character they would cover is handled like any other the text fonts lack.
 */
import PDFDocument, { registerStdFonts } from '../../../../node_modules/pdfkit/js/pdfkit.browser.mjs';
import Courier from 'pdfkit/standard-fonts/Courier';
import CourierBold from 'pdfkit/standard-fonts/CourierBold';
import CourierBoldOblique from 'pdfkit/standard-fonts/CourierBoldOblique';
import CourierOblique from 'pdfkit/standard-fonts/CourierOblique';
import Helvetica from 'pdfkit/standard-fonts/Helvetica';
import HelveticaBold from 'pdfkit/standard-fonts/HelveticaBold';
import HelveticaBoldOblique from 'pdfkit/standard-fonts/HelveticaBoldOblique';
import HelveticaOblique from 'pdfkit/standard-fonts/HelveticaOblique';
import TimesBold from 'pdfkit/standard-fonts/TimesBold';
import TimesBoldItalic from 'pdfkit/standard-fonts/TimesBoldItalic';
import TimesItalic from 'pdfkit/standard-fonts/TimesItalic';
import TimesRoman from 'pdfkit/standard-fonts/TimesRoman';

registerStdFonts(
  Courier,
  CourierBold,
  CourierBoldOblique,
  CourierOblique,
  Helvetica,
  HelveticaBold,
  HelveticaBoldOblique,
  HelveticaOblique,
  TimesBold,
  TimesBoldItalic,
  TimesItalic,
  TimesRoman,
);

export { PDFDocument };
export type PdfDoc = InstanceType<typeof PDFDocument>;
