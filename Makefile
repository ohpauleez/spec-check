
include Makefile.preamble

# Tools/Executables
# ---------------------------------------------------------------
# None

# Vars/Settings
# ---------------------------------------------------------------
# None

## Dumping ground // Notes
## --------------------------------
#

# This captures all the arguments after `make TARGET` allowing you to pass them as args to something else
# Note: This doesn't work as expected if someone types multiple targets `make TARG1 TARG2 ...`
XTRA_ARGS := $(wordlist 2,$(words $(MAKECMDGOALS)),$(MAKECMDGOALS))

.DEFAULT_GOAL := check

# Notes on tooling:
# ESW ensures stable platform version, independent of systems/local machine setups/etc.
# In this respect, all necessary "tooling" is built for use within a project - a JDK version, Clojure tooling, etc.
# and the tooling is confirmed via a series of checksums.
# The Clojure tooling is a series of Bash scripts written by the Clojure.core team directly.
# These scripts are expected to be installed via a package management tool, as a system-level install.
# The scripts do not resolve binaries via `env`, only uses the system PATH directly, and do not respect common JVM environment variables.
# This creates a situation in which the Clojure tooling cannot be told to use our 'tooling' JVM -- it will only ever use a system-level JVM install.
# `sed` is used to update the Clojure tooling scripts to use env, respect local PATH settings, and respect some JVM envvars.
# The 'Darwin' `sed` approach follows a POSIX spec, forcing a newline after the '2i\' expression.  The newline is injected via sed/Bash escaping.

tooling:
	$(MAKE) $(join tooling_,$(shell uname -s))

.PHONY : format
format:
	@$(NPM) run lint:fix

.PHONY : check
check:
	@$(NPM) run lint \
	&& $(NPM) run build \
	&& $(NPM) run test:trace

.PHONY : test
test:
	@$(NPM) run test

.PHONY : dist
dist:
	@$(NPM) run build \
	&& $(NPM) run bundle
	#&& $(NPM) run smoke:parity

.PHONY : run
run:
	@node ./dist/src/index.js $(XTRA_ARGS)

.PHONY : clean
clean:
	@rm -rf ./dist

#.PHONY : prep-env
#prep-env:
#	@echo "Ensuring the existance of $(JVM_MEM) worth of huge/large pages"
#	#echo 512 > /sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages #512 per 1G, you shouls also enable an additional 1-2G for non-Java heap allocations
#	#echo 512 > /proc/sys/vm/nr_hugepages #assumes /proc/meminfo says Hugepagesize if 2048 kB
#	#echo "vm.nr_hugepages=512" >> /etc/sysctl.conf # If we want to ensure the pages are always on boot set via sysctl
#	sysctl vm.nr_hugepages=512
#	@echo "Pushing CPU govenors into performance mode"
#	cpufreq-set -r -g performance # For Debian.  If you're on a RH-derived OS, this is most likely cpupower frequency-set -g performance
#	@echo "Turn down swappiness"
#	sysctl vm.swappiness=10
#	@echo "Turn up max files / open files"
#	sysctl fs.file-max=2097152 # Global - Somewhere between 1048576-2097152 is good, check /proc/sys/fs/nr_open and /proc/sys/fs/file-nr to see settings and relative maxes
#	sysctl fs.nr_open=1048576 # Max num of file-handler per-process.
#	@echo "Disabling TCP Slow-start at the OS level"
#	sysctl net.ipv4.tcp_slow_start_after_idle=0
#	@echo "Ensuring TCP is using the BBR congestion algo and Fair Queueing"
#	sysctl net.ipv4.tcp_congestion_control=bbr
#	sysctl net.core.default_qdisc=fq
#	@echo "Expanding TCP buffer sizes; Be cautious of buffer bloat"
#	sysctl net.ipv4.tcp_notsent_lowat=16384 # 16K of additional buffer over cong window; at most 16K of lower-priority data will be buffered before a higher pri can interrupt it
#	sysctl net.ipv4.tcp_rmem='4096 87380 33554432' # TCP autotuning read-buffer MIN DEFAULT MAX=32MB; Max allowed in Linux is 2Gb - 2147483647
#	sysctl net.ipv4.tcp_wmem='4096 65536 33554432' # TCP autotuning write-buffer MIN DEFAULT MAX=32MB; Max allowed in Linuc is 2Gb - 2147483647
#	sysctl net.ipv4.tcp_max_syn_backlog=8096
#	@echo "Expanding Network/NIC buffer sizes; Be cautious of buffer bloat"
#	sysctl net.core.rmem_max=67108864 # 64MB per socket if needed; Max allowed in Linux is 2Gb 2147483647; 16MB is 16777216
#	sysctl net.core.wmem_max=67108864  # 64MB per socket if needed; Max allowed in Linux is 2Gb 2147483647; 16Mb is 16777216
#	sysctl net.core.netdev_max_backlog=5000 # This can be higher if needed
#	sysctl net.core.somaxconn=1000 # This can be higher if needed
#	@echo "You may want to setup something to adjust /proc/[pid]/oom_score_adj, setting it to -500 or 500" # CAUTION HERE: http://man7.org/linux/man-pages/man5/proc.5.html
#	@echo "You should also look at: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/enhanced-networking-os.html"

.PHONY : tooling_Linux
tooling_Linux:
	mkdir -p ./tooling \
	&& cd tooling \
	&& wget $(alloy_url)/$(alloy_version) -O alloy_v6.0.2.jar \
	&& wget $(tla_url)/$(tla_version) -O tla2tools_v1.8.0.jar \
	&& wget $(z3_url)/$(z3_version)

.PHONY : tooling_Darwin
tooling_Darwin:
	mkdir -p ./tooling \
	&& cd tooling \
	&& wget $(alloy_url)/$(alloy_version) -O alloy_v6.0.2.jar \
	&& wget $(tla_url)/$(tla_version) -O tla2tools_v1.8.0.jar \
	&& wget $(z3_url)/$(z3_version)
