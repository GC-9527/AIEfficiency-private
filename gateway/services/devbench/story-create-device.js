const text = (value) => String(value ?? "").trim();

function invalid(code, error, statusCode = 409, extra = {}) {
  return { ok: false, statusCode, code, error, ...extra };
}

/**
 * Validate a target-device binding at the server boundary.
 *
 * Binding is intentionally non-exclusive: several stories may target the same
 * physical device. Exclusive access belongs to the runtime lease coordinator
 * and is acquired only when scripts/install/tests actually start. ADB
 * enumeration remains fail-closed so a new binding cannot silently target an
 * unavailable serial.
 */
export async function validateStoryCreationDevice(serial, {
  listDevices,
} = {}) {
  const deviceSerial = text(serial);
  if (!deviceSerial) return { ok: true, serial: "" };

  let result;
  try {
    result = await listDevices();
  } catch (error) {
    return invalid(
      "STORY_DEVICE_ENUMERATION_FAILED",
      `无法确认设备 ${deviceSerial} 的在线状态：${error?.message || String(error)}`,
      503,
    );
  }
  if (!result?.ok || !Array.isArray(result.devices)) {
    return invalid(
      "STORY_DEVICE_ENUMERATION_FAILED",
      `无法确认设备 ${deviceSerial} 的在线状态：${text(result?.error) || "ADB 设备枚举失败"}`,
      503,
    );
  }
  const device = result.devices.find((item) => text(item?.id) === deviceSerial);
  if (!device) {
    return invalid("STORY_DEVICE_NOT_FOUND", `未发现设备 ${deviceSerial}，请刷新设备列表后重试`, 409);
  }
  if (text(device.status) !== "device") {
    return invalid(
      "STORY_DEVICE_NOT_READY",
      `设备 ${deviceSerial} 当前状态为 ${text(device.status) || "unknown"}，尚不可用于故事点`,
      409,
      { deviceStatus: text(device.status) || "unknown" },
    );
  }
  return { ok: true, serial: deviceSerial, device };
}
