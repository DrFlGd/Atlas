import multiprocessing
import sys

if __name__ == "__main__":
    # The file readers run in a child process (worker.py), started with `spawn`: in the single-file executable the
    # child is this same program, and this call turns it into the reader before the command line is looked at.
    multiprocessing.freeze_support()

    from atlas_gamefiles.cli import main

    sys.exit(main())
