const button = document.getElementById("company-login");
const status = document.getElementById("status");
button.addEventListener("click", async () => {
  if (button.disabled) return;
  button.disabled = true;
  status.textContent = "正在打开公司登录…";
  try {
    await window.dshWelcome.skip();
  } catch {
    button.disabled = false;
    status.textContent = "公司登录未能打开，请重试。";
  }
});
