import assert from "node:assert/strict";
import test from "node:test";

import { installAuthenticatedOnboarding } from "../../packages/adapter-web/dist/index.js";

class FakeElement extends EventTarget {
  constructor() {
    super();
    this.dataset = {};
    this.disabled = false;
    this.textContent = "";
    this.value = "";
    this.#selectors = new Map();
  }

  #selectors;

  bind(selector, element) {
    this.#selectors.set(selector, element);
    return this;
  }

  querySelector(selector) {
    return this.#selectors.get(selector) ?? null;
  }

  setAttribute(name, value) {
    this[name] = value;
  }
}

function fakeRoot(shell) {
  return {
    querySelector(selector) {
      if (selector === "[data-authenticated-onboarding]") return shell;
      return null;
    },
  };
}

function fakeForm() {
  const form = new FakeElement();
  form.reportValidity = () => true;
  return form;
}

test("onboarding submit dispatches one stable isolated-account command", () => {
  const shell = new FakeElement();
  const form = fakeForm();
  const button = new FakeElement();
  const input = new FakeElement();
  const status = new FakeElement();
  input.value = "  Andrey  ";
  form.dataset.bootstrapKey = "bootstrap-attempt-0001";
  form
    .bind('button[type="submit"]', button)
    .bind('[name="display_name"]', input)
    .bind("[data-bootstrap-status]", status);
  shell.bind("[data-isolated-account-form]", form);

  const commands = [];
  shell.addEventListener("mind-diary:bootstrap-account", (event) => {
    commands.push(event.detail);
  });
  const cleanup = installAuthenticatedOnboarding(fakeRoot(shell));

  form.dispatchEvent(new Event("submit", { cancelable: true }));
  form.dispatchEvent(new Event("submit", { cancelable: true }));

  assert.deepEqual(commands, [{
    action: "create_isolated_account",
    displayName: "Andrey",
    idempotencyKey: "bootstrap-attempt-0001",
  }]);
  assert.equal(button.disabled, true);
  assert.equal(status.textContent, "Creating your account and My Mind…");
  cleanup();
});

test("profile submit dispatches one CAS-bound command and disables resubmission", () => {
  const shell = new FakeElement();
  const form = fakeForm();
  const button = new FakeElement();
  const input = new FakeElement();
  const status = new FakeElement();
  input.value = "  Updated name  ";
  form.dataset.profileVersion = "3";
  form.dataset.profileKey = "profile-attempt-0001";
  form
    .bind('button[type="submit"]', button)
    .bind('[name="display_name"]', input)
    .bind("[data-profile-status]", status);
  shell.bind("[data-profile-form]", form);

  const commands = [];
  shell.addEventListener("mind-diary:update-profile", (event) => {
    commands.push(event.detail);
  });
  const cleanup = installAuthenticatedOnboarding(fakeRoot(shell));

  form.dispatchEvent(new Event("submit", { cancelable: true }));
  form.dispatchEvent(new Event("submit", { cancelable: true }));

  assert.deepEqual(commands, [{
    displayName: "Updated name",
    expectedProfileVersion: 3,
    idempotencyKey: "profile-attempt-0001",
  }]);
  assert.equal(input.disabled, true);
  assert.equal(button.disabled, true);
  assert.equal(status.textContent, "Saving your profile name…");
  cleanup();
});
