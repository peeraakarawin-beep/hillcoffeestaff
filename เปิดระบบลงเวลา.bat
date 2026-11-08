@echo off
chcp 65001 >nul
title ระบบลงเวลาพนักงาน
echo.
echo  ╔════════════════════════════════════════╗
echo  ║      ระบบลงเวลาพนักงาน                ║
echo  ║   Employee Time Attendance System      ║
echo  ╚════════════════════════════════════════╝
echo.
echo  เปิดเบราว์เซอร์ที่ http://localhost:8080
echo  กด Ctrl+C เพื่อปิด Server
echo.
cd /d "%~dp0"
start "" "http://localhost:8080"
python -m http.server 8080
pause
