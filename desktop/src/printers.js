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
# One line per COM port: name <TAB> device id <TAB> Bluetooth address <TAB> paired device's name.
# A paired Bluetooth printer gets two ports: the outgoing one carries the printer's address,
# the incoming one carries 000000000000 and never reaches the printer.
$all = @(Get-CimInstance Win32_PnPEntity)
$devices = 'HKLM:\SYSTEM\CurrentControlSet\Services\BTHPORT\Parameters\Devices'
foreach ($p in $all) {
  if ([string]$p.Name -notmatch '\((COM\d+)\)') { continue }
  $id = [string]$p.PNPDeviceID; $bt = ''; $dev = ''
  if ($id -match '^BTHENUM\\' -and $id -match '&([0-9A-Fa-f]{12})_') { $bt = $Matches[1].ToUpper() }
  if ($bt -and $bt -ne '000000000000') {
    $raw = (Get-ItemProperty -Path ("$devices\" + $bt.ToLower()) -Name Name).Name
    if ($raw) { $dev = [Text.Encoding]::UTF8.GetString([byte[]]$raw).Trim([char]0).Trim() }
    if (-not $dev) { $d = $all | Where-Object { [string]$_.PNPDeviceID -like "BTHENUM\DEV_$bt*" } | Select-Object -First 1; if ($d) { $dev = [string]$d.Name } }
  }
  @([string]$p.Name, $id, $bt, $dev) -join [char]9
}
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

/**
 * Parses list-com.ps1 lines: "name\tdeviceId\tbtAddress\tdeviceName" (older one-column lines work too).
 * Each port gets kind: 'bluetooth' (sends to a paired device), 'bluetooth-incoming' (only listens,
 * never reaches a printer, so it is left out) or 'serial' (a cable port such as COM1).
 * Bluetooth ports come first.
 */
function parseComPorts(text) {
  const seen = new Set();
  const ports = [];
  for (const line of String(text).split(/\r?\n/)) {
    const [name = '', id = '', bt = '', device = ''] = line.split('\t').map((s) => s.trim());
    const m = /\((COM\d+)\)/i.exec(name);
    if (!m) continue;
    const p = m[1].toUpperCase();
    if (seen.has(p)) continue;
    seen.add(p);
    const bluetooth = /^BTHENUM\\/i.test(id) || /bluetooth/i.test(name);
    let kind = bluetooth ? 'bluetooth' : 'serial';
    if (bluetooth && /^0{12}$/.test(bt)) kind = 'bluetooth-incoming';
    const port = { path: p, name, kind };
    if (device) port.device = device;
    ports.push(port);
  }
  const rank = { bluetooth: 0, serial: 1, 'bluetooth-incoming': 2 };
  return ports.filter((x) => x.kind !== 'bluetooth-incoming').sort((a, b) => rank[a.kind] - rank[b.kind]);
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function serialWrite(port, bytes, { settleMs = 1500 } = {}) {
  // Opening a Bluetooth COM port makes Windows connect to the printer. Keep the port open
  // a moment after writing: closing it at once can drop the link before the bytes go out.
  const target = IS_WIN ? `\\\\.\\${port}` : port;
  let fh;
  try {
    fh = await fs.promises.open(target, 'r+');
    let off = 0;
    while (off < bytes.length) {
      const { bytesWritten } = await fh.write(bytes, off, bytes.length - off);
      if (!bytesWritten) throw new Error('the port took no data');
      off += bytesWritten;
    }
    await sleep(settleMs);
  } catch (err) {
    throw new Error(`Couldn't reach the printer on ${port}. Check it is on and paired. (${err.code || err.message})`);
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
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

module.exports = { createBackend, parseComPorts, serialWrite, RAW_PRINT_PS1, LIST_COM_PS1 };
