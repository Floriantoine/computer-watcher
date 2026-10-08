import { memo, useId } from 'react';
import { motion } from 'motion/react';
import { sameSeries } from '../../renderEquality';
import { sparkPath } from './sparkPath';

export type SparkTone = 'mem' | 'swap' | 'psi' | 'cpu' | 'warn' | 'bad';

interface Props {
  values: (number | null)[];
  tone: SparkTone;
  height?: number;
}

function SparklineImpl({ values, tone, height = 28 }: Props) {
  const id = useId();
  if (values.filter((v) => v !== null).length < 2) return null;
  const { line, area } = sparkPath(values, 100, height);
  const grad = `spark-${id}`;
  return (
    <motion.svg
      className={`spark spark-${tone}`}
      viewBox={`0 0 100 ${height}`}
      preserveAspectRatio="none"
      style={{ height }}
      aria-hidden="true"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
    >
      <defs>
        <linearGradient id={grad} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" className="spark-stop-a" />
          <stop offset="100%" className="spark-stop-b" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${grad})`} opacity={0.35} />
      <path d={line} fill="none" className="spark-line" strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </motion.svg>
  );
}

/** Ne se redessine que si les valeurs changent réellement (les snapshots arrivent toutes les 3 s). */
export const Sparkline = memo(SparklineImpl, (a, b) => a.tone === b.tone && a.height === b.height && sameSeries(a.values, b.values));
