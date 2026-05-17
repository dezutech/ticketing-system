function xmlEscape(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function pdfEscape(value) {
    return String(value ?? '').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function crc32(buffer) {
    let crc = -1;
    for (const byte of buffer) {
        crc ^= byte;
        for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ -1) >>> 0;
}

function zipStore(files) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const file of files) {
        const name = Buffer.from(file.name);
        const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
        const crc = crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 6);
        local.writeUInt16LE(0, 8);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);
        localParts.push(local, name, data);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0, 8);
        central.writeUInt16LE(0, 10);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(offset, 42);
        centralParts.push(central, name);
        offset += local.length + name.length + data.length;
    }

    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...localParts, ...centralParts, end]);
}

function makeXlsx(report) {
    const rows = [
        [report.title],
        ['Generated', report.generatedAt],
        ['Filters', report.filtersText || 'None'],
        [],
        ['Summary'],
        ...Object.entries(report.summary || {}).map(([key, value]) => [key, value]),
        [],
        report.headers,
        ...report.rows
    ];
    const sheetRows = rows.map((row, rIdx) => `
        <row r="${rIdx + 1}">
            ${row.map((cell, cIdx) => `<c r="${String.fromCharCode(65 + cIdx)}${rIdx + 1}" t="inlineStr"><is><t>${xmlEscape(cell)}</t></is></c>`).join('')}
        </row>
    `).join('');
    const files = [
        { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>` },
        { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
        { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Report" sheetId="1" r:id="rId1"/></sheets></workbook>` },
        { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>` },
        { name: 'xl/worksheets/sheet1.xml', data: `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>` }
    ];
    return zipStore(files);
}

function makePdf(report) {
    const headers = Array.isArray(report.headers) ? report.headers : [];
    const rows = Array.isArray(report.rows) ? report.rows : [];
    const tableLines = rows.length
        ? rows.map(row => row.map(value => String(value ?? '').replace(/\s+/g, ' ').slice(0, 24)).join(' | '))
        : ['No records matched the selected filters.'];
    const lines = [
        { text: 'HelpDesk Ticketing System', size: 16, gap: 22 },
        { text: report.title || 'System Report', size: 13, gap: 18 },
        { text: `Generated: ${report.generatedAt || new Date().toLocaleString('en-PH')}`, size: 9, gap: 14 },
        { text: `Filters: ${report.filtersText || 'None'}`, size: 9, gap: 18 },
        { text: 'Summary', size: 11, gap: 15 },
        ...Object.entries(report.summary || {}).map(([key, value]) => ({ text: `${key}: ${value}`, size: 9, gap: 13 })),
        { text: '', size: 9, gap: 12 },
        { text: headers.length ? headers.join(' | ') : 'Report Data', size: 9, gap: 14 },
        { text: '-'.repeat(115), size: 9, gap: 12 },
        ...tableLines.map(text => ({ text, size: 8, gap: 12 }))
    ];

    const pages = [];
    let current = [];
    let y = 760;
    for (const line of lines) {
        if (y < 50 && current.length) {
            pages.push(current);
            current = [];
            y = 760;
        }
        current.push(line);
        y -= line.gap;
    }
    if (current.length) pages.push(current);

    const objects = ['', null, null, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`];
    const pageRefs = [];
    for (const page of pages) {
        let yPos = 760;
        const commands = page.map(line => {
            const command = `BT /F1 ${line.size || 9} Tf 40 ${yPos} Td (${pdfEscape(line.text)}) Tj ET`;
            yPos -= line.gap || 13;
            return command;
        }).join('\n');
        const contentId = objects.length;
        objects.push(`<< /Length ${Buffer.byteLength(commands)} >>\nstream\n${commands}\nendstream`);
        const pageId = objects.length;
        objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`);
        pageRefs.push(`${pageId} 0 R`);
    }

    objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
    objects[2] = `<< /Type /Pages /Kids [${pageRefs.join(' ')}] /Count ${pageRefs.length} >>`;
    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    for (let i = 1; i < objects.length; i++) {
        offsets[i] = Buffer.byteLength(pdf);
        pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
    }
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
    for (let i = 1; i < objects.length; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
    pdf += `trailer << /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return Buffer.from(pdf);
}

module.exports = { makePdf, makeXlsx };
