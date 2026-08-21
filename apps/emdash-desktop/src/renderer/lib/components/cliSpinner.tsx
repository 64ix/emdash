import { useEffect, useState } from 'react';

const FRAMES_1 = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FRAMES_2 = [
  '⠈',
  '⠉',
  '⠋',
  '⠓',
  '⠒',
  '⠐',
  '⠐',
  '⠒',
  '⠖',
  '⠦',
  '⠤',
  '⠠',
  '⠠',
  '⠤',
  '⠦',
  '⠖',
  '⠒',
  '⠐',
  '⠐',
  '⠒',
  '⠓',
  '⠋',
  '⠉',
  '⠈',
];

export function CLISpinner({ variant = '1' }: { variant?: '1' | '2' }) {
  const [index, setIndex] = useState(0);
  const frames = variant === '1' ? FRAMES_1 : FRAMES_2;

  useEffect(() => {
    // NOTE: functional update — depending on `index` here would tear down and
    // recreate the interval on every tick.
    const interval = setInterval(() => {
      setIndex((i) => (i + 1) % frames.length);
    }, 80);
    return () => clearInterval(interval);
  }, [frames]);

  return <span className="text-foreground/60">{frames[index % frames.length]}</span>;
}
