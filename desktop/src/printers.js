'use strict';
/**
 * Talks to the printers this computer already has. Nothing here replaces or
 * changes a printer driver: on Windows, receipts go through the driver's own
 * print queue (winspool, datatype RAW), the same way POS software has always
 * printed ESC/POS to a thermal printer.
 */
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';

// Sends a file's bytes to a Windows printer queue unchanged (RAW).
const RAW_PRINT_PS1 = String.raw`
param([Parameter(Mandatory=$true)][string]$Printer, [Parameter(Mandatory=$true)][string]$File)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class UltraPosRawPrint {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO { public string pDocName; public string pOutputFile; public string pDataType; }
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool OpenPrinter(string name, out IntPtr handle, IntPtr defaults);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern int StartDocPrinter(IntPtr h, int level, [In] DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool WritePrinter(IntPtr h, byte[] b, int n, out int written);
  public static void Send(string printer, byte[] bytes) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Exception("Can't open printer (error " + Marshal.GetLastWin32Error() + ")");
    try {
      DOCINFO di = new DOCINFO(); di.pDocName = "Ultra POS receipt"; di.pDataType = "RAW";
      if (StartDocPrinter(h, 1, di) == 0) throw new Exception("The printer refused the job (error " + Marshal.GetLastWin32Error() + ")");
      try {
        StartPagePrinter(h);
        int written;
        if (!WritePrinter(h, bytes, bytes.Length, out written) || written != bytes.Length)
          throw new Exception("Only " + written + " of " + bytes.Length + " bytes reached the printer");
        EndPagePrinter(h);
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}
"@
[UltraPosRawPrint]::Send($Printer, [System.IO.File]::ReadAllBytes($File))
`;

const LIST_COM_PS1 = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Get-CimInstance Win32_PnPEntity | Where-Object { $_.Name -match '\((COM\d+)\)' } | ForEach-Object { $_.Name }
`;

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || '').trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' ');
        reject(new Error(detail || err.message));
      } else {
        resolve(String(stdout));
      }
    });
  });
}

let scriptDir = null;
function scriptPath(name, body) {
  if (!scriptDir) scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ultrapos-'));
  const file = path.join(scriptDir, name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, body);
  return file;
}

function powershell(name, body, params, timeoutMs) {
  return run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath(name, body), ...params,
  ], timeoutMs);
}

function tempJobFile(bytes) {
  const file = path.join(os.tmpdir(), `ultrapos-job-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
  fs.writeFileSync(file, bytes);
  return file;
}

async function rawPrint(printerName, bytes) {
  const file = tempJobFile(bytes);
  try {
    if (IS_WIN) {
      await powershell('raw-print.ps1', RAW_PRINT_PS1, ['-Printer', printerName, '-File', file], 60_000);
    } else {
      await run('lp', ['-d', printerName, '-o', 'raw', file], 60_000);
    }
  } catch (e) {
    throw new Error(`Couldn't print to "${printerName}": ${e.message}`);
  } finally {
    fs.rm(file, { force: true }, () => {});
  }
}

/** Parses "Standard Serial over Bluetooth link (COM5)" lines. */
function parseComPorts(text) {
  const seen = new Set();
  const ports = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /\((COM\d+)\)/i.exec(line);
    if (!m) continue;
    const p = m[1].toUpperCase();
    if (seen.has(p)) continue;
    seen.add(p);
    ports.push({ path: p, name: line.trim() });
  }
  return ports;
}

async function listSerialPorts() {
  if (IS_WIN) return parseComPorts(await powershell('list-com.ps1', LIST_COM_PS1, [], 20_000));
  try {
    return fs.readdirSync('/dev')
      .filter((n) => /^cu\./.test(n) && !/Bluetooth-Incoming-Port|debug-console/i.test(n))
      .map((n) => ({ path: `/dev/${n}`, name: n.slice(3) }));
  } catch {
    return [];
  }
}

function serialWrite(port, bytes) {
  // Opening a Bluetooth COM port makes Windows connect to the printer.
  const target = IS_WIN ? `\\\\.\\${port}` : port;
  return new Promise((resolve, reject) => {
    fs.writeFile(target, bytes, (err) => {
      if (err) reject(new Error(`Couldn't reach the printer on ${port}. Check it is on and paired. (${err.code || err.message})`));
      else resolve();
    });
  });
}

/** getPrinters: () => Promise<Electron.PrinterInfo[]> from a webContents. */
function createBackend({ getPrinters, pick }) {
  return {
    async listPrinters() {
      const list = (await getPrinters()) || [];
      return list.map((p) => ({ name: p.name, displayName: p.displayName || p.name, isDefault: !!p.isDefault }));
    },
    listSerialPorts,
    rawPrint,
    serialWrite,
    pick,
  };
}

module.exports = { createBackend, parseComPorts, RAW_PRINT_PS1 };
