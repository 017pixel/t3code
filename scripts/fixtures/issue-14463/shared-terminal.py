#!/usr/bin/env python3
"""Deterministic real PTY fixture: --mode tui|normal|burst; q exits TUI."""
import argparse
import curses
import os
import signal
import sys

parser = argparse.ArgumentParser()
parser.add_argument('--mode', choices=['tui', 'normal', 'burst'], default='tui')
parser.add_argument('--label', default='Shared terminal')
args = parser.parse_args()


def normal():
    sys.stdout.write('\x1b[?1049l\x1b[0m\x1b[2J\x1b[H\x1b[?25h\x1b[?12l')
    for row in range(1, 61):
        print(f'ROW {row:03d} | ' + '0123456789' * 12, flush=True)
    sys.stdout.write('CURSOR> \x1b[?25h\x1b[?12l')
    sys.stdout.flush()
    for line in sys.stdin:
        if line.strip() == 'q':
            break
        sys.stdout.write('INPUT ' + line + 'CURSOR> ')
        sys.stdout.flush()


def tui(screen):
    curses.start_color()
    curses.init_pair(1, curses.COLOR_WHITE, curses.COLOR_BLUE)
    screen.bkgd(' ', curses.color_pair(1))
    curses.curs_set(1)
    while True:
        rows, cols = screen.getmaxyx()
        screen.erase()
        if rows > 2 and cols > 2:
            screen.border('|', '|', '-', '-', '+', '+', '+', '+')
            lines = [f'{args.label} {cols} columns x {rows} rows',
                     'Every border must be visible', 'Resize either client; q exits',
                     '0123456789' * 40]
            for row, line in enumerate(lines, 1):
                if row < rows - 1:
                    screen.addnstr(row, 1, line, cols - 2)
            if rows > 6:
                screen.addnstr(rows - 2, 1, 'BOTTOM EDGE', cols - 2)
            screen.move(min(5, rows - 2), min(3, cols - 2))
        screen.refresh()
        if screen.getch() in (ord('q'), 3):
            break


if args.mode == 'normal':
    normal()
elif args.mode == 'burst':
    for row in range(20000):
        print(f'BURST {row:05d} ' + '0123456789' * 20)
    sys.stdout.flush()
    curses.wrapper(tui)
else:
    curses.wrapper(tui)
