<!DOCTYPE html>
<html lang="bn">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>আমার মিনি অ্যাপ</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
</head>
<body style="font-family: sans-serif; text-align: center; padding: 40px;">
  <h2>স্বাগতম! এটি আমার টেলিগ্রাম মিনি অ্যাপ</h2>
  <p id="user"></p>

  <script>
    const tg = window.Telegram.WebApp;
    tg.expand();
    const user = tg.initDataUnsafe?.user;
    if (user) {
      document.getElementById("user").innerText = "নাম: " + user.first_name;
    }
  </script>
</body>
</html>
