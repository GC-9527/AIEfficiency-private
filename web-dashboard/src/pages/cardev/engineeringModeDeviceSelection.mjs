function deviceId(device) {
  return String(device?.id || device?.serial || "").trim();
}

export function engineeringModeButtonLabel(plugin) {
  return `进入${String(plugin?.displayName || "车机工程模式")}`;
}

export function connectedEngineeringModeDevices(devices) {
  const seen = new Set();
  return (Array.isArray(devices) ? devices : []).filter((device) => {
    const id = deviceId(device);
    if (!id || device?.status !== "device" || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function resolveEngineeringModeDeviceFlow(devices) {
  const connected = connectedEngineeringModeDevices(devices);
  if (!connected.length) return { kind: "none", devices: [], selectedSerial: "" };

  if (connected.length > 1) {
    return { kind: "choose", devices: connected, selectedSerial: "" };
  }

  return {
    kind: "direct",
    devices: connected,
    selectedSerial: deviceId(connected[0]),
  };
}
