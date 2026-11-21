// On/off settings from environment variables. People type these in hosting dashboards, so
// "1", "true", "yes" and "on" all mean on (any case, spaces ignored); anything else is off.
export const isOn = (value) => ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
