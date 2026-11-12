import sys

if __name__ == "__main__":
    if sys.argv[1:2] == ["reader"]:
        # The file reader process (reader.py), which the helper starts itself: only the standard library is imported
        # before it says it has begun.
        from atlas_gamefiles.reader import main as reader_main

        sys.exit(reader_main(sys.argv[2:]))

    from atlas_gamefiles.cli import main

    sys.exit(main())
