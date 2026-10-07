"""F-96: CC5 5.13 runs the plugin in its embedded Python 3.8.8. Live 2026-10-07, sys.version read
"3.8.8 (tags/v3.8.8:024d805, Feb 19 2021, 13:18:16) [MSC v.1928 64 bit (AMD64)]", and its crash dumps load
python38.dll. The other tests run under the developer's Python, so a 3.9+ feature passes all of them and fails only
inside CC5, where a syntax error stops the whole plugin. These checks read the source of every cc5-plugin/*.py instead
of running it."""
from __future__ import annotations

import ast
import io
import os
import sys
import tokenize
import unittest

import _support

CC5_PYTHON = (3, 8)

# Builtin types Python 3.8 cannot subscript (PEP 585, 3.9), with the typing name to use instead.
GENERIC_BUILTINS = {"list": "List", "dict": "Dict", "tuple": "Tuple", "set": "Set", "frozenset": "FrozenSet",
                    "type": "Type"}
# Library classes Python 3.8 cannot subscript either (PEP 585): all of collections and collections.abc, and these.
GENERIC_CLASSES = {"queue.Queue", "re.Match", "re.Pattern"}
# Builtin types that | joins into a union only from Python 3.10 on (PEP 604).
TYPE_NAMES = set(GENERIC_BUILTINS) | {"bool", "bytearray", "bytes", "complex", "float", "int", "object", "str"}
# typing's names, which | joins only from Python 3.10 on too. On Python 3.8 a | with one of them, or with None, raises
# TypeError; RLPy's enum flags are neither, so a flag OR (RLPy.A | RLPy.B) stays clean.
TYPING_NAMES = {"Any", "Callable", "Dict", "Iterable", "Iterator", "List", "Mapping", "Optional", "Sequence", "Set",
                "Tuple", "Type", "Union"}
# Library names Python 3.8 lacks (a short list of certain ones), with the version they need and what to do instead.
NEW_MODULES = {
    "graphlib": ("3.9", "write the topological sort out"),
    "zoneinfo": ("3.9", "3.8 has only fixed offsets (datetime.timezone)"),
}
NEW_NAMES = {
    ("functools", "cache"): ("3.9", "use functools.lru_cache(maxsize=None)"),
    ("math", "lcm"): ("3.9", "use a * b // math.gcd(a, b)"),
}
NEW_METHODS = {
    "removeprefix": ("3.9", "use s[len(prefix):] if s.startswith(prefix) else s"),
    "removesuffix": ("3.9", "use s[:-len(suffix)] if suffix and s.endswith(suffix) else s"),
}
# How the 3.8 parse's error for a 3.9+ statement starts, with what to write instead.
GRAMMAR_INSTEAD = {
    "Parenthesized context managers": "nest the with statements, or keep the context managers on one line",
    "Pattern matching": "use if / elif",
}


def parse(source: str, name: str = "<snippet>") -> tuple[ast.Module, list[tuple[int, str]]]:
    """The module's tree, and the syntax in it that Python 3.8 refuses: (line, what to use instead).

    ast.parse with feature_version is best effort: it lets a decorator of any expression (PEP 614, 3.9) and 3.12's
    f-strings (PEP 701) through, so those are checked separately. Its error can point at the line after the statement.
    """
    findings: list[tuple[int, str]] = []
    try:
        tree = ast.parse(source, filename=name, feature_version=CC5_PYTHON)
    except SyntaxError as e:
        instead = next((text for start, text in GRAMMAR_INSTEAD.items() if (e.msg or "").startswith(start)),
                       "write it the Python 3.8 way")
        findings.append((e.lineno or 0, f"{e.msg}; {instead}"))
        tree = ast.parse(source, filename=name)  # this Python's grammar, so the other checks still run
    return tree, findings + decorator_findings(tree) + fstring_findings(source)


def decorator_findings(tree: ast.AST) -> list[tuple[int, str]]:
    """Python 3.8 takes only a dotted name, or a call of one, after @ (PEP 614 allows any expression from 3.9 on)."""
    findings = []
    for node in ast.walk(tree):
        for decorator in getattr(node, "decorator_list", ()):
            target = decorator.func if isinstance(decorator, ast.Call) else decorator
            while isinstance(target, ast.Attribute):
                target = target.value
            if not isinstance(target, ast.Name):
                findings.append((decorator.lineno, "a decorator that is not a dotted name or a call of one needs "
                                                   "Python 3.9 (PEP 614); assign it to a name and decorate with that"))
    return findings


def fstring_findings(source: str) -> list[tuple[int, str]]:
    """What 3.12's f-strings (PEP 701) allow inside {...} and Python 3.8 does not: the f-string's own quote, a
    backslash, a comment and, in a single-quoted f-string, a line break. Before 3.12 such a source does not parse."""
    if not hasattr(tokenize, "FSTRING_START"):
        return []
    findings: list[tuple[int, str]] = []
    quotes: list[str] = []  # the quote of each f-string the tokens are in, outermost first
    for tok in tokenize.generate_tokens(io.StringIO(source).readline):
        line = tok.start[0]
        if tok.type == tokenize.FSTRING_START:
            if quotes:
                findings += _in_braces(tok.string, quotes, line)
            quotes.append(tok.string.lstrip("fFrR"))
        elif tok.type == tokenize.FSTRING_END:
            quotes.pop()
        elif not quotes:
            continue
        elif tok.type == tokenize.FSTRING_MIDDLE:
            if len(quotes) > 1:  # the text of a nested f-string sits inside the outer f-string's {...}
                findings += _in_braces(tok.string, quotes[:-1], line)
        elif tok.type == tokenize.COMMENT:
            findings.append((line, "a comment inside an f-string's {...} needs Python 3.12 (PEP 701); "
                                   "move it out of the f-string"))
        elif tok.type in (tokenize.NL, tokenize.NEWLINE):
            if any(len(quote) == 1 for quote in quotes):
                findings.append((line, "a line break inside a single-quoted f-string's {...} needs Python 3.12 "
                                       "(PEP 701); keep the {...} on one line, or compute the value first"))
        else:
            findings += _in_braces(tok.string, quotes, line)
    return findings


def _in_braces(text: str, quotes: list[str], line: int) -> list[tuple[int, str]]:
    """A token inside an f-string's {...}: Python 3.8 refuses a backslash there and ends the f-string at its quote."""
    findings = []
    if "\\" in text:
        findings.append((line, "a backslash inside an f-string's {...} needs Python 3.12 (PEP 701); "
                               "put the value in a variable before the f-string"))
    clash = [quote for quote in quotes if quote in text]
    if clash:
        findings.append((line, f"the f-string's own quote {clash[0]} inside its {{...}} needs Python 3.12 (PEP 701); "
                               "use the other quote character there"))
    return findings


def _runtime_nodes(tree: ast.AST):
    """Every node Python 3.8 runs. Annotations are left out: under 'from __future__ import annotations' (which
    future_findings holds every module with annotations to) they stay strings."""
    stack = [tree]
    while stack:
        node = stack.pop()
        yield node
        for field, value in ast.iter_fields(node):
            if (field == "annotation" and isinstance(node, (ast.arg, ast.AnnAssign))) or (
                    field == "returns" and isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))):
                continue
            if isinstance(value, ast.AST):
                stack.append(value)
            elif isinstance(value, list):
                stack.extend(item for item in value if isinstance(item, ast.AST))


def runtime_type_findings(tree: ast.AST) -> list[tuple[int, str]]:
    """list[int] or collections.OrderedDict[str, int] (PEP 585, 3.9), and int | str, Foo | None, Any | Foo or a | in
    the classes isinstance() takes (PEP 604, 3.10), where Python 3.8 evaluates them."""
    names = _import_names(tree)
    nodes = list(_runtime_nodes(tree))
    in_class_info = {}  # id of a | in the classes isinstance() or issubclass() takes -> that function's name
    for node in nodes:
        if isinstance(node, ast.Call) and _dotted(node.func) in ("isinstance", "issubclass") and len(node.args) == 2:
            for union in _unions(node.args[1]):
                in_class_info[id(union)] = _dotted(node.func)
    findings = []
    for node in nodes:
        if isinstance(node, ast.Subscript):
            written = _dotted(node.value)
            origin = _resolve(written, names) if written else ""
            if written in GENERIC_BUILTINS:
                findings.append((node.lineno, f"{written}[...] outside an annotation needs Python 3.9 (PEP 585); "
                                              f"use typing.{GENERIC_BUILTINS[written]}[...]"))
            elif origin.startswith("collections.") or origin in GENERIC_CLASSES:
                where = "" if origin == written else f" ({origin})"
                findings.append((node.lineno, f"{written}[...]{where} outside an annotation needs Python 3.9 "
                                              "(PEP 585); use the typing name if there is one, or leave out the [...]"))
        elif isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
            left, right = _type_label(node.left), _type_label(node.right)
            if _is_type(left, names) or _is_type(right, names):
                findings.append((node.lineno, f"{left} | {right} outside an annotation needs Python 3.10 (PEP 604); "
                                              "use a tuple of types in isinstance(), typing.Union or typing.Optional "
                                              "elsewhere"))
            elif id(node) in in_class_info:
                findings.append((node.lineno, f"{left} | {right} in {in_class_info[id(node)]}() needs Python 3.10 "
                                              "(PEP 604); pass a tuple of classes"))
    return findings


def _import_names(tree: ast.AST) -> dict[str, str]:
    """Each name an import binds -> the dotted name it stands for ('import collections.abc as cabc' binds cabc to
    collections.abc, 'from queue import Queue' binds Queue to queue.Queue)."""
    names = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                top = alias.name.partition(".")[0]
                names[alias.asname or top] = alias.name if alias.asname else top
        elif isinstance(node, ast.ImportFrom) and node.module and not node.level:
            for alias in node.names:
                names[alias.asname or alias.name] = f"{node.module}.{alias.name}"
    return names


def _resolve(dotted: str, names: dict[str, str]) -> str:
    """A dotted name with its first part replaced by what an import bound that part to."""
    first, dot, rest = dotted.partition(".")
    return names.get(first, first) + dot + rest


def _dotted(node: ast.AST) -> str | None:
    """'a.b.c' for a name or a chain of attributes on one, else None."""
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if not isinstance(node, ast.Name):
        return None
    return ".".join([node.id] + parts[::-1])


def _unions(node: ast.AST):
    """The | in the classes argument of isinstance() or issubclass(), also inside a tuple there."""
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
        yield node
    elif isinstance(node, ast.Tuple):
        for item in node.elts:
            yield from _unions(item)


def _type_label(node: ast.AST) -> str:
    """The name a | message gives an operand: its (dotted) name, None, or ...; a subscript is named by what it
    subscripts."""
    if isinstance(node, ast.Subscript):
        node = node.value
    if isinstance(node, ast.Constant) and node.value is None:
        return "None"
    return _dotted(node) or "..."


def _is_type(label: str, names: dict[str, str]) -> bool:
    """An operand that makes a | a type union: a builtin type, None or one of typing's names (also as typing.X)."""
    if label in TYPE_NAMES or label == "None":
        return True
    module, _dot, name = _resolve(label, names).rpartition(".")
    return name in TYPING_NAMES and module in ("", "typing")


def library_findings(tree: ast.AST) -> list[tuple[int, str]]:
    """The library names above, zip(strict=...) (3.10), and a | with a dict display or dict() (PEP 584, 3.9)."""
    bound = {}  # name bound by 'import x' or 'import x as y' -> the module
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                top = alias.name.partition(".")[0]
                bound[alias.asname or top] = alias.name if alias.asname else top
    findings = []

    def new_module(line, module):
        top = module.partition(".")[0]
        if top in NEW_MODULES:
            version, instead = NEW_MODULES[top]
            findings.append((line, f"module {top} needs Python {version}; {instead}"))

    def new_name(line, module, name):
        if (module, name) in NEW_NAMES:
            version, instead = NEW_NAMES[module, name]
            findings.append((line, f"{module}.{name} needs Python {version}; {instead}"))

    for node in _runtime_nodes(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                new_module(node.lineno, alias.name)
        elif isinstance(node, ast.ImportFrom) and node.module and not node.level:
            new_module(node.lineno, node.module)
            for alias in node.names:
                new_name(node.lineno, node.module, alias.name)
        elif isinstance(node, ast.Attribute):
            if node.attr in NEW_METHODS:
                version, instead = NEW_METHODS[node.attr]
                findings.append((node.lineno, f"str.{node.attr} needs Python {version}; {instead}"))
            elif isinstance(node.value, ast.Name):
                new_name(node.lineno, bound.get(node.value.id, node.value.id), node.attr)
        elif (isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "zip"
              and any(keyword.arg == "strict" for keyword in node.keywords)):
            findings.append((node.lineno, "zip(strict=...) needs Python 3.10; compare the lengths before zip()"))
        elif isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr) and (
                _is_dict(node.left) or _is_dict(node.right)):
            findings.append((node.lineno, "dict | dict needs Python 3.9 (PEP 584); use {**a, **b}"))
        elif isinstance(node, ast.AugAssign) and isinstance(node.op, ast.BitOr) and _is_dict(node.value):
            findings.append((node.lineno, "dict |= dict needs Python 3.9 (PEP 584); use a.update(b)"))
    return findings


def _is_dict(node: ast.AST) -> bool:
    """A dict display, a dict comprehension or a dict() call: a | with one of them is dict | dict."""
    return isinstance(node, (ast.Dict, ast.DictComp)) or (
        isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "dict")


def future_findings(tree: ast.Module) -> list[tuple[int, str]]:
    """The first annotation of a module without 'from __future__ import annotations'."""
    for node in tree.body:
        if (isinstance(node, ast.ImportFrom) and node.module == "__future__"
                and any(alias.name == "annotations" for alias in node.names)):
            return []
    lines = []
    for node in ast.walk(tree):
        if isinstance(node, ast.arg) and node.annotation is not None:
            lines.append(node.annotation.lineno)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.returns is not None:
            lines.append(node.returns.lineno)
        elif isinstance(node, ast.AnnAssign):
            lines.append(node.annotation.lineno)
    if not lines:
        return []
    return [(min(lines), "an annotation in a module without 'from __future__ import annotations': Python 3.8 "
                         "evaluates it at run time, where list[str] or str | None raise TypeError; add the import "
                         "after the module docstring")]


class PluginOnPython38Test(unittest.TestCase):
    """Every cc5-plugin/*.py (install-plugin.ps1 copies them all to CC5) must run on CC5 5.13's Python 3.8.8."""

    @classmethod
    def setUpClass(cls):
        cls.modules = []  # (file name, tree, syntax Python 3.8 refuses)
        for name in sorted(os.listdir(_support.PLUGIN_DIR)):
            if name.endswith(".py"):
                # utf-8-sig: Python imports a source file that starts with a UTF-8 BOM; ast.parse of the text does not.
                with open(os.path.join(_support.PLUGIN_DIR, name), encoding="utf-8-sig") as f:
                    source = f.read()
                cls.modules.append((name,) + parse(source, name))

    def assertClean(self, findings):
        """findings: file name -> [(line, what Python 3.8 refuses and what to use instead)]."""
        lines = [f"{name}:{line}: {message}" for name in sorted(findings) for line, message in sorted(findings[name])]
        if lines:
            self.fail("CC5 5.13 runs the plugin in Python 3.8.8 (F-96):\n" + "\n".join(lines))

    def test_every_plugin_module_is_read(self):
        names = [name for name, _tree, _grammar in self.modules]
        for name in ("main.py", "server.py", "cc5_api.py"):
            self.assertIn(name, names)

    def test_every_module_parses_as_python_3_8(self):
        self.assertClean({name: grammar for name, _tree, grammar in self.modules})

    def test_no_builtin_generics_or_type_unions_outside_annotations(self):
        self.assertClean({name: runtime_type_findings(tree) for name, tree, _grammar in self.modules})

    def test_no_library_names_python_3_8_lacks(self):
        self.assertClean({name: library_findings(tree) for name, tree, _grammar in self.modules})

    def test_every_module_with_annotations_imports_annotations_from_future(self):
        self.assertClean({name: future_findings(tree) for name, tree, _grammar in self.modules})


# Python 3.8 refuses lines 3, 4 and 7 to 14 when they run. The annotations on lines 5 and 6 are fine there under
# 'from __future__ import annotations', which this snippet lacks.
RUNTIME_SNIPPET = '''\
import functools
import math as m
from zoneinfo import ZoneInfo
from functools import cache
def f(names: list[str], kind: int | None = None) -> dict[str, int]:
    seen: set[str] = set()
    alias = dict[str, int]
    ok = isinstance(kind, int | str)
    a = functools.cache
    b = m.lcm(4, 6)
    c = names[0].removeprefix("x")
    d = zip(names, names, strict=True)
    e = {"a": 1} | {"b": 2}
    e |= {"c": 3}
    seen |= {"d"}
    return seen
'''

# Python 3.8 raises TypeError on lines 4 to 14 when they run: a | with a typing name (4, 6) or None (5), a | in the
# classes isinstance() or issubclass() takes (7, 8), and a library class with [...] (9 to 14). Lines 15 to 21 run
# there: RLPy's enum flags, sets and ints with |, a tuple of classes, typing's own [...] and an attribute named like a
# module. Lines 22 and 23 are annotations.
LIBRARY_TYPES_SNIPPET = '''\
import collections, collections.abc as cabc, queue, re, typing, RLPy
from collections import OrderedDict as OD
from typing import Any, Optional
a = Any | Foo
b = RLPy.RIAvatar | None
c = Optional[int] | typing.Callable
d = isinstance(o, Foo | Bar)
e = issubclass(k, (Foo, Bar | Baz))
f = collections.OrderedDict[str, int]()
g = cabc.Iterable[int]
h = queue.Queue[str]()
i = OD[str, int]
j = re.Pattern[str]
k = re.Match[str]
l = RLPy.EExportFbxOptions_EmbedTexture | RLPy.EExportFbxOptions_RemoveHiddenMesh
m = set(x) | set(y)
n = flags | 4
o = isinstance(o, (Foo, Bar))
p = typing.Optional[int]
q = command_queue.queue[0]
r = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
def s(x: queue.Queue[str] | None = None) -> re.Match[str] | None:
    t: collections.deque[int] | Any = collections.deque()
'''

# 3.12's f-strings: Python 3.8 refuses line 1 (the f-string's own quote), 2 (a backslash), 6 (a line break in a
# single-quoted f-string) and 9 (a comment). Lines 3 to 5 are fine there, and so are the line breaks on 8 and 9.
F_STRING_SNIPPET = r'''a = f"{x["k"]}"
b = f"{'\n'.join(y)}"
c = f'{d["k"]} {e!r:>{w}}'
g = f"""{h["k"]}"""
i = f"{f'{j}'}"
k = f"{len([
  l])}"
m = f"""{len([
  n,  # note
])}"""
'''


class ChecksFindTest(unittest.TestCase):
    """The checks above find what they look for: a check that never fires would pass any plugin."""

    @unittest.skipIf(sys.version_info < (3, 10), "a match statement does not parse before Python 3.10")
    def test_the_parse_refuses_a_match_statement(self):
        _tree, found = parse("match x:\n    case 1:\n        pass\n")
        self.assertEqual(len(found), 1, found)
        self.assertIn("3.10", found[0][1])  # only the text: the error's line can be the one after the statement

    @unittest.skipIf(sys.version_info < (3, 9), "a decorator of any expression does not parse before Python 3.9")
    def test_decorators_must_be_dotted_names_or_calls_of_them(self):
        found = decorator_findings(ast.parse("@a.b\n@c(1)\n@d[0]\n@e.f(2)(3)\ndef g():\n    pass\n"))
        self.assertEqual(sorted(line for line, _message in found), [3, 4])
        self.assertIn("PEP 614", found[0][1])

    @unittest.skipUnless(hasattr(tokenize, "FSTRING_START"), "3.12's f-strings do not tokenize before Python 3.12")
    def test_f_strings_python_3_8_cannot_read(self):
        found = fstring_findings(F_STRING_SNIPPET)
        self.assertEqual([line for line, _message in found], [1, 2, 6, 9])
        for (_line, message), words in zip(found, ("own quote", "backslash", "line break", "comment")):
            self.assertIn(words, message)

    def test_builtin_generics_and_type_unions_outside_annotations(self):
        found = runtime_type_findings(ast.parse(RUNTIME_SNIPPET))
        self.assertEqual(sorted(line for line, _message in found), [7, 8])
        self.assertIn("use typing.Dict[...]", dict(found)[7])
        self.assertIn("int | str outside an annotation needs Python 3.10", dict(found)[8])

    def test_unions_with_none_or_typing_names_and_library_generics(self):
        found = runtime_type_findings(ast.parse(LIBRARY_TYPES_SNIPPET))
        self.assertEqual(sorted(line for line, _message in found), list(range(4, 15)))
        messages = dict(found)
        self.assertIn("Any | Foo outside an annotation needs Python 3.10 (PEP 604)", messages[4])
        self.assertIn("RLPy.RIAvatar | None outside an annotation needs Python 3.10", messages[5])
        self.assertIn("Optional | typing.Callable outside an annotation", messages[6])
        self.assertIn("Foo | Bar in isinstance() needs Python 3.10 (PEP 604); pass a tuple of classes", messages[7])
        self.assertIn("Bar | Baz in issubclass()", messages[8])
        self.assertIn("collections.OrderedDict[...] outside an annotation needs Python 3.9 (PEP 585)", messages[9])
        self.assertIn("cabc.Iterable[...] (collections.abc.Iterable) outside an annotation", messages[10])
        self.assertIn("queue.Queue[...] outside an annotation", messages[11])
        self.assertIn("OD[...] (collections.OrderedDict) outside an annotation", messages[12])
        self.assertIn("re.Pattern[...] outside an annotation", messages[13])
        self.assertIn("re.Match[...] outside an annotation", messages[14])

    def test_library_names_python_3_8_lacks(self):
        found = library_findings(ast.parse(RUNTIME_SNIPPET))
        self.assertEqual(sorted(line for line, _message in found), [3, 4, 9, 10, 11, 12, 13, 14])
        self.assertIn("module zoneinfo needs Python 3.9", dict(found)[3])
        self.assertIn("math.lcm needs Python 3.9", dict(found)[10])  # imported as m
        self.assertIn("str.removeprefix needs Python 3.9", dict(found)[11])

    def test_annotations_need_the_future_import(self):
        self.assertEqual([line for line, _message in future_findings(ast.parse(RUNTIME_SNIPPET))], [5])
        self.assertEqual(future_findings(ast.parse("from __future__ import annotations\n" + RUNTIME_SNIPPET)), [])
        self.assertEqual(future_findings(ast.parse('"""No annotations."""\nx = 1\n')), [])


if __name__ == "__main__":
    unittest.main()
