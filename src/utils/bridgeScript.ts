export const BRIDGE_SCRIPT_SOURCE = `#!/usr/bin/env node
// Damaria Docs Local Printer & Photocopier Bridge (Zero dependencies)
// Run on the print-room computer: node damaria-docs-bridge.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PORT = 4777;
const TMP_DIR = path.join(os.tmpdir(), 'damaria-docs-bridge');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

function mapWindowsStatus(code) {
  const map = {
    1: 'Other',
    2: 'Unknown',
    3: 'Ready',
    4: 'Printing',
    5: 'Warmup',
    6: 'Stopped',
    7: 'Offline',
  };
  return map[code] || 'Ready';
}

async function listLocalMachines() {
  const platform = process.platform;
  if (platform === 'win32') {
    const psScript = \`
      Get-CimInstance Win32_Printer | Select-Object Name,PortName,DriverName,PrinterStatus,DetectedErrorState,WorkOffline,Default | ConvertTo-Json -Compress
    \`;
    try {
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', psScript], { timeout: 5000 });
      const raw = stdout.trim();
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      return list.map((p) => {
        const port = String(p.PortName || '');
        const isUsb = /USB/i.test(port);
        const offline = Boolean(p.WorkOffline) || Number(p.PrinterStatus) === 7;
        const errCode = Number(p.DetectedErrorState || 0);
        let paperState = 'Ready';
        let inkBlack = null;
        if (errCode === 4 || errCode === 5) paperState = 'Out of Paper';
        if (errCode === 8) paperState = 'Paper Jam';
        if (errCode === 6 || errCode === 7) inkBlack = 10;
        return {
          name: p.Name,
          portName: port,
          driverName: p.DriverName || 'Windows Print Driver',
          isUsb,
          isDefault: Boolean(p.Default),
          online: !offline,
          statusText: offline ? 'Offline' : mapWindowsStatus(Number(p.PrinterStatus)),
          inkBlack,
          paperState,
        };
      });
    } catch {
      return [];
    }
  }

  try {
    const { stdout: pOut } = await execFileAsync('lpstat', ['-p'], { timeout: 4000 });
    let vOut = '';
    try {
      const vRes = await execFileAsync('lpstat', ['-v'], { timeout: 4000 });
      vOut = vRes.stdout;
    } catch {}
    const portMap = {};
    for (const line of vOut.split('\\n')) {
      const m = line.match(/^device for ([^:]+):\\s*(.+)$/);
      if (m) portMap[m[1].trim()] = m[2].trim();
    }
    const machines = [];
    for (const line of pOut.split('\\n')) {
      const m = line.match(/^printer\\s+(\\S+)\\s+(.+)$/);
      if (!m) continue;
      const name = m[1];
      const info = m[2];
      const portName = portMap[name] || 'CUPS Local';
      const offline = /disabled|offline/i.test(info);
      machines.push({
        name,
        portName,
        driverName: 'CUPS',
        isUsb: /usb/i.test(portName),
        isDefault: false,
        online: !offline,
        statusText: info.trim(),
        inkBlack: null,
        paperState: /media-empty|out of paper/i.test(info) ? 'Out of Paper' : 'Ready',
      });
    }
    return machines;
  } catch {
    return [];
  }
}

async function printLocalFile({ printerName, copies, fileName, fileBase64, renderedHtml }) {
  const safeName = (fileName || 'document.txt').replace(/[^a-zA-Z0-9._-]/g, '_');
  let targetPath = path.join(TMP_DIR, Date.now() + '_' + safeName);

  if (fileBase64) {
    fs.writeFileSync(targetPath, Buffer.from(fileBase64, 'base64'));
  } else {
    targetPath = targetPath.replace(/\\.[^.]+$/, '') + '.html';
    fs.writeFileSync(targetPath, '<html><body>' + (renderedHtml || '') + '</body></html>', 'utf-8');
  }

  const count = Math.max(1, Number(copies) || 1);
  if (process.platform === 'win32') {
    for (let i = 0; i < Math.min(count, 50); i++) {
      await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-Command',
        \`Start-Process -FilePath "\${targetPath}" -Verb PrintTo -ArgumentList "\${printerName}" -WindowStyle Hidden\`,
      ]);
    }
    return { ok: true, message: \`Dispatched \${count} copy print job to \${printerName} via Windows spooler.\` };
  }

  await execFileAsync('lp', ['-d', printerName, '-n', String(count), targetPath]);
  return { ok: true, message: \`Dispatched \${count} copies to \${printerName} via CUPS.\` };
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/machines') {
    const machines = await listLocalMachines();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, platform: process.platform, machines }));
    return;
  }

  if (req.method === 'POST' && req.url === '/print') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      try {
        const body = JSON.parse(raw);
        const result = await printLocalFile(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('Damaria Docs Local Print Bridge running at http://127.0.0.1:' + PORT);
});
`;
