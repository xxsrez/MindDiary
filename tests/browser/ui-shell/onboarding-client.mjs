import { installAuthenticatedOnboarding } from "/ui/onboarding.js";

globalThis.__mindDiaryEvents = [];
document.documentElement.dataset.fixtureClientReady = "true";
const eventLog = document.createElement("ol");
eventLog.hidden = true;
eventLog.dataset.fixtureEvents = "";
document.body.append(eventLog);
for (const type of [
  "mind-diary:bootstrap-account",
  "mind-diary:manual-recovery",
  "mind-diary:update-profile",
  "mind-diary:refresh-session",
]) {
  document.addEventListener(type, (event) => {
    globalThis.__mindDiaryEvents.push({ type, detail: event.detail ?? null });
    const item = document.createElement("li");
    item.dataset.fixtureEvent = type;
    item.textContent = JSON.stringify(event.detail ?? null);
    eventLog.append(item);
  });
}

installAuthenticatedOnboarding(document);
