#!/bin/sh
# Build the wide corpus: Word documents from three producers that are not this
# project, to round trip with `npm run try`.
#
#   sh scripts/fidelity/wide/make_all.sh <output folder>
#
# Producer one is python-docx. Producer two is LibreOffice, which rewrites each
# of those through its own document model, so what comes out is the same content
# in completely different markup: its own styles, its own numbering, its own way
# of writing tables, headers and fields. Producer three is the converter that
# ships with macOS, from HTML and RTF. Each step is skipped, and says so, where
# its tool is not installed. None of this runs in the product or on a server.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-wide-corpus}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

if python3 -c "import docx" 2>/dev/null; then
	python3 "$HERE/make_python_docx.py" "$OUT"
else
	echo "skipped: python-docx is not installed (pip install python-docx)"
fi

SOFFICE="${DOCFORGE_SOFFICE:-soffice}"
if command -v "$SOFFICE" >/dev/null 2>&1; then
	work="$(mktemp -d)"
	# Through OpenDocument and back, so that LibreOffice writes the Word file
	# from its own model rather than passing the original through.
	"$SOFFICE" --headless --convert-to odt --outdir "$work/odt" "$OUT"/py-*.docx >/dev/null 2>&1 || true
	cp "$HERE/rich-policy.fodt" "$work/odt/rich-policy.fodt"
	"$SOFFICE" --headless --convert-to 'docx:MS Word 2007 XML' --outdir "$work/docx" "$work"/odt/* >/dev/null 2>&1 || true
	for file in "$work"/docx/*.docx; do
		[ -f "$file" ] || continue
		name="$(basename "$file" | sed 's/^py-/lo-/')"
		case "$name" in lo-*) ;; *) name="lo-$name" ;; esac
		cp "$file" "$OUT/$name"
		echo "$name"
	done
	rm -rf "$work"
else
	echo "skipped: LibreOffice is not installed (set DOCFORGE_SOFFICE to its soffice)"
fi

if command -v textutil >/dev/null 2>&1; then
	work="$(mktemp -d)"
	cat > "$work/mac-01-html-report.html" <<'HTML'
<html><head><meta charset="utf-8"><title>Quarterly report</title>
<style>h1{color:#1f4e79;font-family:Georgia}td,th{border:1px solid #444;padding:4px}th{background:#1f3864;color:#fff}.warn{background:#ffff00}.small{font-size:9pt;font-family:Courier New}</style></head><body>
<h1>Quarterly report</h1><h2>Summary</h2>
<p style="text-align:justify">The position is <b>stable</b>, with <i>two</i> items <u>outside appetite</u> and one <s>closed</s> <span class="warn">re-opened</span>. Capital is 1.4x<sup>a</sup> and H<sub>2</sub> unchanged. See <a href="https://standards.example.invalid/report">the standard</a>.</p>
<h2>Actions</h2><ol><li>Complete exit plans<ul><li>for hosting</li><li>for payments</li></ul></li><li>Exercise audit rights</li><li>Commission a study</li></ol>
<h3>Exposure</h3><table><tr><th>Region</th><th>Retail</th><th>Commercial</th></tr><tr><td rowspan="2">Domestic</td><td>412.5</td><td>1,208.0</td></tr><tr><td>88.1</td><td>240.9</td></tr><tr><td colspan="2">International total</td><td>669.7</td></tr></table>
<blockquote>The committee notes the position.</blockquote><p class="small">Small monospaced footer text.</p><p style="text-align:center">Centred closing line.</p><p style="text-align:right">Right-aligned sign-off.</p>
</body></html>
HTML
	printf '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Times New Roman;}{\\f1 Arial;}}{\\colortbl;\\red192\\green0\\blue0;\\red31\\green78\\blue121;}\\f1\\fs36\\cf2\\b Notice of change\\b0\\cf0\\fs24\\par\\f0 This notice takes effect on {\\b 1 October}. It replaces the {\\i earlier} notice and {\\ul must} be read with {\\cf1 the red schedule}.\\par\\li720 An indented paragraph of the notice, which carries on for long enough to wrap onto a second line in any reasonable page width.\\par\\li0\\qc Centred line\\par\\qr Right line\\par\\ql{\\*\\pn\\pnlvlblt\\pnf1\\pnindent360{\\pntxtb\\bullet}}\\fi-360\\li720 First point\\par Second point\\par\\pard After the list.\\par}' > "$work/mac-02-rtf-notice.rtf"
	for file in "$work"/mac-*; do
		name="$(basename "${file%.*}").docx"
		textutil -convert docx -output "$OUT/$name" "$file" && echo "$name"
	done
	rm -rf "$work"
else
	echo "skipped: textutil is only on macOS"
fi

echo
echo "$(ls "$OUT"/*.docx | wc -l | tr -d ' ') documents in $OUT"
echo "Round trip them with:  npm run build && npm run try -- --keep $OUT/roundtrip $OUT"
