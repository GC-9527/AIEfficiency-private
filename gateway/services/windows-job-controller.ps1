param(
  [Parameter(Mandatory = $true)]
  [string]$EncodedPayload,
  [Parameter(Mandatory = $true)]
  [string]$NodeExecutable,
  [Parameter(Mandatory = $true)]
  [string]$LauncherPath
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading.Tasks;

public static class AIEfficiencyJobNative
{
    private const UInt32 JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public UInt64 ReadOperationCount;
        public UInt64 WriteOperationCount;
        public UInt64 OtherOperationCount;
        public UInt64 ReadTransferCount;
        public UInt64 WriteTransferCount;
        public UInt64 OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public Int64 PerProcessUserTimeLimit;
        public Int64 PerJobUserTimeLimit;
        public UInt32 LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public UInt32 ActiveProcessLimit;
        public UIntPtr Affinity;
        public UInt32 PriorityClass;
        public UInt32 SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public Int64 TotalUserTime;
        public Int64 TotalKernelTime;
        public Int64 ThisPeriodTotalUserTime;
        public Int64 ThisPeriodTotalKernelTime;
        public UInt32 TotalPageFaultCount;
        public UInt32 TotalProcesses;
        public UInt32 ActiveProcesses;
        public UInt32 TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        Int32 infoClass,
        ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info,
        UInt32 length
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(
        IntPtr job,
        Int32 infoClass,
        out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info,
        UInt32 length,
        out UInt32 returnedLength
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, UInt32 exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    public static IntPtr CreateKillOnClose()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
            throw new Win32Exception(Marshal.GetLastWin32Error());

        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        UInt32 size = (UInt32)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        if (!SetInformationJobObject(job, 9, ref info, size))
        {
            int error = Marshal.GetLastWin32Error();
            CloseHandle(job);
            throw new Win32Exception(error);
        }
        return job;
    }

    public static void Assign(IntPtr job, IntPtr process)
    {
        if (!AssignProcessToJobObject(job, process))
            throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    public static UInt32 ActiveProcesses(IntPtr job)
    {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info;
        UInt32 returnedLength;
        UInt32 size = (UInt32)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
        if (!QueryInformationJobObject(job, 1, out info, size, out returnedLength))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return info.ActiveProcesses;
    }

    public static void Terminate(IntPtr job, UInt32 exitCode)
    {
        if (!TerminateJobObject(job, exitCode))
            throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    public static void Close(IntPtr job)
    {
        if (job != IntPtr.Zero) CloseHandle(job);
    }

    public static async Task CopyAndCloseAsync(Stream source, Stream destination)
    {
        try
        {
            await source.CopyToAsync(destination).ConfigureAwait(false);
            await destination.FlushAsync().ConfigureAwait(false);
        }
        finally
        {
            // CopyToAsync only copies bytes; it does not close the destination.
            // CLI commands such as `codex exec ... -` wait for EOF before they
            // start processing the complete prompt, so propagate EOF explicitly.
            destination.Dispose();
            source.Dispose();
        }
    }
}
'@

$job = [IntPtr]::Zero
$gatePath = $null
$launcher = $null
$stdoutTask = $null
$stderrTask = $null
$stdinTask = $null
$exitCode = 125

try {
  $job = [AIEfficiencyJobNative]::CreateKillOnClose()
  $gatePath = Join-Path (
    [System.IO.Path]::GetTempPath()
  ) "aieff-cli-job-$([Guid]::NewGuid().ToString('N')).gate"

  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $NodeExecutable
  $startInfo.Arguments = "`"$LauncherPath`""
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.WorkingDirectory = (Get-Location).Path
  $startInfo.EnvironmentVariables["AIEFF_CLI_JOB_GATE"] = $gatePath
  $startInfo.EnvironmentVariables["AIEFF_CLI_JOB_PAYLOAD"] = $EncodedPayload

  $launcher = [System.Diagnostics.Process]::new()
  $launcher.StartInfo = $startInfo
  if (-not $launcher.Start()) {
    throw "CLI Job launcher 启动失败"
  }
  $stdoutTask = $launcher.StandardOutput.BaseStream.CopyToAsync(
    [Console]::OpenStandardOutput()
  )
  $stderrTask = $launcher.StandardError.BaseStream.CopyToAsync(
    [Console]::OpenStandardError()
  )
  $stdinTask = [AIEfficiencyJobNative]::CopyAndCloseAsync(
    [Console]::OpenStandardInput(),
    $launcher.StandardInput.BaseStream
  )

  [AIEfficiencyJobNative]::Assign($job, $launcher.Handle)
  [System.IO.File]::WriteAllText($gatePath, "go")
  $launcher.WaitForExit()
  $exitCode = $launcher.ExitCode

  while ([AIEfficiencyJobNative]::ActiveProcesses($job) -gt 0) {
    [AIEfficiencyJobNative]::Terminate($job, 143)
    Start-Sleep -Milliseconds 100
  }
  # EOF 转发任务正常完成时已经关闭该流；这里仅负责 child 先退出时的兜底关闭。
  try { $launcher.StandardInput.Close() } catch {}
  [void]($stdoutTask.GetAwaiter().GetResult())
  [void]($stderrTask.GetAwaiter().GetResult())
} catch {
  [Console]::Error.WriteLine("CLI Job controller 失败: $($_.Exception.Message)")
  $exitCode = 125
  if ($job -ne [IntPtr]::Zero) {
    try { [AIEfficiencyJobNative]::Terminate($job, 125) } catch {}
  }
} finally {
  if ($gatePath -and [System.IO.File]::Exists($gatePath)) {
    [System.IO.File]::Delete($gatePath)
  }
  if ($launcher) { $launcher.Dispose() }
  if ($job -ne [IntPtr]::Zero) { [AIEfficiencyJobNative]::Close($job) }
}

exit $exitCode
