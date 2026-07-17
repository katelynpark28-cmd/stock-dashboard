@echo off
REM ============================================================
REM  StocKP launcher - double-click this to start the dashboard
REM  Opens the backend (port 3001) and frontend (port 5174)
REM  in their own windows. Keep both windows open while using it.
REM ============================================================
cd /d "C:\Users\katel\Documents\stock-dashboard"

start "StocKP Backend (port 3001)"  cmd /k npm run server
start "StocKP Frontend (port 5174)" cmd /k npm run dev

echo.
echo  StocKP is starting in two new windows.
echo  Give it ~10 seconds, then open:  http://localhost:5174
echo.
echo  Keep BOTH windows open while you use it.
echo  (Closing a window stops that part of the app.)
echo.
pause
