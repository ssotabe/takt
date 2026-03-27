from scipy import stats
import numpy as np

# Case 1: empty arrays
try:
    r = stats.spearmanr(np.array([]), np.array([]))
    print(f"Empty: statistic={r.statistic}, pvalue={r.pvalue}")
except Exception as e:
    print(f"Empty: error={e}")

# Case 2: single element
try:
    r = stats.spearmanr(np.array([1.0]), np.array([2.0]))
    print(f"Single: statistic={r.statistic}, pvalue={r.pvalue}")
except Exception as e:
    print(f"Single: error={e}")

# Case 3: constant values
r = stats.spearmanr(np.array([1.0, 1.0, 1.0]), np.array([1.0, 2.0, 3.0]))
print(f"Constant: statistic={r.statistic}, pvalue={r.pvalue}")

# Case 4: NaN propagation through bonferroni
p_values = np.array([0.01, float("nan"), 0.05])
adjusted = np.minimum(p_values * len(p_values), 1.0)
print(f"Bonferroni with NaN: {adjusted}")

# Case 5: NaN propagation through FDR-BH
print(f"NaN < 0.05 = {float('nan') < 0.05}")
print(f"int(NaN) causes error?")
try:
    print(int(float("nan") < 0.05))
except Exception as e:
    print(f"  error: {e}")
